import { BadRequestException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from '../permissions/permissions.service';
import { User } from '../users/entities/user.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';
import { VirtualDriveService } from '../virtual-fs/virtual-drive.service';
import { CreatePublicShareDto, PublicShareExpiry } from './dto/create-public-share.dto';
import { PublicShareDownloadDto } from './dto/public-share-download.dto';
import { PublicShare, PublicSharePermission } from './entities/public-share.entity';

@Injectable()
export class PublicSharesService {
  constructor(
    @InjectRepository(PublicShare) private readonly shares: Repository<PublicShare>,
    @InjectRepository(VirtualNode) private readonly nodes: Repository<VirtualNode>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly drive: VirtualDriveService,
  ) {}

  async create(ownerUserId: string, dto: CreatePublicShareDto) {
    await this.permissions.requireOwner(ownerUserId, dto.nodeId);
    const node = await this.nodes.findOne({ where: { id: dto.nodeId, userId: ownerUserId, deletedAt: IsNull() } });
    if (!node) throw new NotFoundException('Virtual node not found');
    if (node.type !== VirtualNodeType.FILE) throw new BadRequestException('Public links currently support files only');
    if (dto.permission === PublicSharePermission.VIEW_ONLY && dto.downloadLimit != null) {
      throw new BadRequestException('Download limits require download permission');
    }

    const expiresAt = this.expiration(dto);
    const token = randomBytes(32).toString('base64url');
    const passwordHash = dto.password ? await argon2.hash(dto.password) : null;
    const share = await this.shares.save(this.shares.create({
      ownerUserId,
      nodeId: node.id,
      tokenHash: this.hashToken(token),
      permission: dto.permission,
      expiresAt,
      passwordHash,
      downloadLimit: dto.downloadLimit ?? null,
      downloadCount: 0,
      enabled: true,
      revokedAt: null,
    }));
    await this.audit.record(ownerUserId, 'PUBLIC_LINK_CREATED', 'VirtualNode', node.id, {
      publicShareId: share.id,
      permission: share.permission,
      expiresAt: share.expiresAt?.toISOString() ?? null,
      passwordProtected: Boolean(passwordHash),
      downloadLimit: share.downloadLimit,
    });
    const frontendUrl = this.config.get<string>('app.frontendUrl') ?? 'http://localhost:4200';
    return {
      ...this.toManagedResponse(share, node),
      token,
      url: `${frontendUrl.replace(/\/$/, '')}/s/${token}`,
    };
  }

  async list(ownerUserId: string, page = 1, limit = 25, nodeId?: string) {
    const query = this.shares.createQueryBuilder('share')
      .addSelect('share.passwordHash')
      .where('share.ownerUserId = :ownerUserId', { ownerUserId })
    if (nodeId) query.andWhere('share.nodeId = :nodeId', { nodeId });
    const [shares, total] = await query.orderBy('share.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const nodeIds = [...new Set(shares.map((share) => share.nodeId))];
    const nodes = nodeIds.length ? await this.nodes.find({ where: nodeIds.map((id) => ({ id })) }) : [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return {
      items: shares.flatMap((share) => {
        const node = nodeById.get(share.nodeId);
        return node ? [this.toManagedResponse(share, node)] : [];
      }),
      page,
      limit,
      total,
    };
  }

  async revoke(ownerUserId: string, shareId: string) {
    const share = await this.shares.findOne({ where: { id: shareId, ownerUserId } });
    if (!share) throw new NotFoundException('Public share not found');
    if (!share.enabled || share.revokedAt) return { revoked: true };
    share.enabled = false;
    share.revokedAt = new Date();
    await this.shares.save(share);
    await this.audit.record(ownerUserId, 'PUBLIC_LINK_REVOKED', 'VirtualNode', share.nodeId, { publicShareId: share.id });
    return { revoked: true };
  }

  async publicInfo(token: string, password?: string) {
    const share = await this.findActiveByToken(token, true);
    if (share.passwordHash) {
      if (!password) return { passwordRequired: true };
      const valid = await argon2.verify(share.passwordHash, password).catch(() => false);
      if (!valid) throw new NotFoundException('Public share not found');
    }
    const node = await this.nodes.findOne({ where: { id: share.nodeId, userId: share.ownerUserId, deletedAt: IsNull() } });
    if (!node) throw new NotFoundException('Public share not found');
    const owner = await this.users.findOne({ where: { id: share.ownerUserId }, select: { id: true, username: true } });
    return {
      passwordRequired: false,
      ownerName: owner?.username ?? 'Usuario CloudFusion',
      permission: share.permission,
      expiresAt: share.expiresAt,
      downloadLimit: share.downloadLimit,
      downloadCount: share.downloadCount,
      resource: { name: node.name, type: node.type, mimeType: node.mimeType, size: node.size == null ? null : Number(node.size) },
    };
  }

  async download(token: string, dto: PublicShareDownloadDto) {
    const share = await this.findActiveByToken(token, true);
    if (share.passwordHash) {
      const valid = dto.password ? await argon2.verify(share.passwordHash, dto.password).catch(() => false) : false;
      if (!valid) throw new NotFoundException('Public share not found');
    }
    if (share.permission !== PublicSharePermission.DOWNLOAD) throw new ForbiddenException('Downloads are disabled for this link');

    const reserved = await this.dataSource.query(
      `UPDATE public_shares
       SET download_count = download_count + 1
       WHERE id = $1 AND enabled = true AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
         AND (download_limit IS NULL OR download_count < download_limit)
       RETURNING id`,
      [share.id],
    ) as Array<{ id: string }>;
    if (reserved.length === 0) throw new GoneException('PUBLIC_SHARE_DOWNLOAD_LIMIT_REACHED');

    let file;
    try {
      file = await this.drive.download(share.ownerUserId, share.nodeId);
    } catch (error) {
      await this.dataSource.query('UPDATE public_shares SET download_count = GREATEST(download_count - 1, 0) WHERE id = $1', [share.id]);
      throw error;
    }
    await this.audit.record(share.ownerUserId, 'PUBLIC_LINK_DOWNLOADED', 'VirtualNode', share.nodeId, { publicShareId: share.id });
    return file;
  }

  private async findActiveByToken(token: string, includePasswordHash: boolean): Promise<PublicShare> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException('Public share not found');
    const query = this.shares.createQueryBuilder('share')
      .where('share.tokenHash = :tokenHash', { tokenHash: this.hashToken(token) })
      .andWhere('share.enabled = true')
      .andWhere('share.revokedAt IS NULL');
    if (includePasswordHash) query.addSelect('share.passwordHash');
    const share = await query.getOne();
    if (!share || (share.expiresAt && share.expiresAt <= new Date())) throw new NotFoundException('Public share not found');
    if (share.downloadLimit != null && share.downloadCount >= share.downloadLimit) throw new GoneException('PUBLIC_SHARE_DOWNLOAD_LIMIT_REACHED');
    return share;
  }

  private expiration(dto: CreatePublicShareDto): Date | null {
    const now = Date.now();
    if (!dto.expiry) {
      const configuredDays = Number(this.config.get<string | number>('PUBLIC_SHARE_DEFAULT_EXPIRY_DAYS') ?? 7);
      const safeDays = Number.isSafeInteger(configuredDays) && configuredDays > 0 && configuredDays <= 3650 ? configuredDays : 7;
      return new Date(now + safeDays * 24 * 60 * 60 * 1000);
    }
    switch (dto.expiry) {
      case PublicShareExpiry.NEVER: return null;
      case PublicShareExpiry.ONE_DAY: return new Date(now + 24 * 60 * 60 * 1000);
      case PublicShareExpiry.SEVEN_DAYS: return new Date(now + 7 * 24 * 60 * 60 * 1000);
      case PublicShareExpiry.THIRTY_DAYS: return new Date(now + 30 * 24 * 60 * 60 * 1000);
      case PublicShareExpiry.CUSTOM: {
        const custom = dto.expiresAt ? new Date(dto.expiresAt) : null;
        if (!custom || Number.isNaN(custom.getTime()) || custom.getTime() <= now) throw new BadRequestException('A future expiry date is required for a custom link');
        return custom;
      }
    }
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toManagedResponse(share: PublicShare, node: VirtualNode) {
    return {
      id: share.id,
      node: { id: node.id, name: node.name, type: node.type, mimeType: node.mimeType, size: node.size == null ? null : Number(node.size) },
      permission: share.permission,
      expiresAt: share.expiresAt,
      passwordProtected: Boolean(share.passwordHash),
      downloadLimit: share.downloadLimit,
      downloadCount: share.downloadCount,
      enabled: share.enabled,
      createdAt: share.createdAt,
      revokedAt: share.revokedAt,
    };
  }
}
