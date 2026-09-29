import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { PermissionsService } from '../permissions/permissions.service';
import {
  ResourceShare,
  ResourceShareRole,
  ResourceShareStatus,
} from '../permissions/entities/resource-share.entity';
import { CreateShareDto } from './dto/create-share.dto';
import { ShareListQueryDto } from './dto/share-list-query.dto';
import { SearchUsersQueryDto } from './dto/search-users-query.dto';
import { UpdateShareDto } from './dto/update-share.dto';

@Injectable()
export class SharingService {
  constructor(
    @InjectRepository(ResourceShare) private readonly shares: Repository<ResourceShare>,
    @InjectRepository(VirtualNode) private readonly nodes: Repository<VirtualNode>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
  ) {}

  async create(ownerUserId: string, dto: CreateShareDto) {
    await this.permissions.requireOwner(ownerUserId, dto.nodeId);
    const node = await this.nodes.findOne({ where: { id: dto.nodeId, userId: ownerUserId, deletedAt: IsNull() } });
    if (!node) throw new NotFoundException('Virtual node not found');

    const recipient = await this.users.findOne({
      where: { email: dto.email.trim().toLowerCase(), status: UserStatus.ACTIVE },
      select: { id: true, email: true, username: true },
    });
    if (!recipient) throw new NotFoundException('Active CloudFusion user not found');
    if (recipient.id === ownerUserId) throw new BadRequestException('You cannot share a resource with yourself');

    let share = await this.shares.findOne({ where: { nodeId: node.id, sharedWithUserId: recipient.id } });
    if (share) {
      share.ownerUserId = ownerUserId;
      share.role = dto.role;
      share.status = ResourceShareStatus.ACTIVE;
      share.revokedAt = null;
    } else {
      share = this.shares.create({
        ownerUserId,
        nodeId: node.id,
        sharedWithUserId: recipient.id,
        role: dto.role,
        status: ResourceShareStatus.ACTIVE,
        revokedAt: null,
      });
    }
    share = await this.shares.save(share);
    await this.audit.record(ownerUserId, 'RESOURCE_SHARED', 'VirtualNode', node.id, {
      shareId: share.id,
      recipientUserId: recipient.id,
      role: share.role,
    });
    return this.toShareResponse(share, node, recipient);
  }

  async received(userId: string, query: ShareListQueryDto) {
    const [shares, total] = await this.shares.findAndCount({
      where: { sharedWithUserId: userId, status: ResourceShareStatus.ACTIVE, revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const items = await this.mapShares(shares, true);
    return { items, page: query.page, limit: query.limit, total };
  }

  async created(userId: string, query: ShareListQueryDto) {
    const [shares, total] = await this.shares.findAndCount({
      where: { ownerUserId: userId, status: ResourceShareStatus.ACTIVE, revokedAt: IsNull(), ...(query.nodeId ? { nodeId: query.nodeId } : {}) },
      order: { createdAt: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const items = await this.mapShares(shares, false);
    return { items, page: query.page, limit: query.limit, total };
  }

  async update(ownerUserId: string, shareId: string, dto: UpdateShareDto) {
    const share = await this.getOwnedShare(ownerUserId, shareId);
    share.role = dto.role;
    const updated = await this.shares.save(share);
    await this.audit.record(ownerUserId, 'RESOURCE_SHARE_ROLE_CHANGED', 'VirtualNode', share.nodeId, { shareId, role: share.role });
    const [item] = await this.mapShares([updated], false);
    return item;
  }

  async revoke(ownerUserId: string, shareId: string) {
    const share = await this.getOwnedShare(ownerUserId, shareId);
    share.status = ResourceShareStatus.REVOKED;
    share.revokedAt = new Date();
    await this.shares.save(share);
    await this.audit.record(ownerUserId, 'RESOURCE_SHARE_REVOKED', 'VirtualNode', share.nodeId, { shareId });
    return { revoked: true };
  }

  async searchUsers(userId: string, query: SearchUsersQueryDto) {
    const term = query.q.trim().toLowerCase();
    const builder = this.users.createQueryBuilder('user')
      .select(['user.id', 'user.username', 'user.email'])
      .where('user.status = :status', { status: UserStatus.ACTIVE })
      .andWhere('user.id <> :userId', { userId });
    if (term.includes('@')) {
      builder.andWhere('LOWER(user.email) = :email', { email: term });
    } else {
      if (!/^[a-z0-9_-]+$/.test(term)) {
        return { items: [], page: query.page, limit: query.limit, total: 0 };
      }
      builder.andWhere('user.username ILIKE :username', { username: `${term}%` });
    }
    const [users, total] = await builder
      .orderBy('user.username', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return {
      items: users.map(({ id, username, email }) => ({ id, username, email })),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  private async getOwnedShare(ownerUserId: string, shareId: string): Promise<ResourceShare> {
    const share = await this.shares.findOne({ where: { id: shareId, ownerUserId, status: ResourceShareStatus.ACTIVE, revokedAt: IsNull() } });
    if (!share) throw new NotFoundException('Share not found');
    await this.permissions.requireOwner(ownerUserId, share.nodeId);
    return share;
  }

  private async mapShares(shares: ResourceShare[], received: boolean) {
    if (shares.length === 0) return [];
    const nodeIds = [...new Set(shares.map((share) => share.nodeId))];
    const userIds = [...new Set(shares.map((share) => received ? share.ownerUserId : share.sharedWithUserId))];
    const [nodes, users] = await Promise.all([
      this.nodes.find({ where: nodeIds.map((id) => ({ id, deletedAt: IsNull() })) }),
      this.users.find({ where: userIds.map((id) => ({ id })), select: { id: true, username: true, email: true } }),
    ]);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const userById = new Map(users.map((user) => [user.id, user]));
    return shares.flatMap((share) => {
      const node = nodeById.get(share.nodeId);
      const otherUser = userById.get(received ? share.ownerUserId : share.sharedWithUserId);
      return node ? [this.toShareResponse(share, node, otherUser)] : [];
    });
  }

  private toShareResponse(share: ResourceShare, node: VirtualNode, otherUser?: Pick<User, 'id' | 'email' | 'username'>) {
    return {
      id: share.id,
      node: {
        id: node.id,
        name: node.name,
        type: node.type,
        mimeType: node.mimeType,
        size: node.size == null ? null : Number(node.size),
        parentId: node.parentId,
      },
      role: share.role,
      status: share.status,
      createdAt: share.createdAt,
      updatedAt: share.updatedAt,
      user: otherUser ? { id: otherUser.id, username: otherUser.username, email: otherUser.email } : null,
    };
  }
}
