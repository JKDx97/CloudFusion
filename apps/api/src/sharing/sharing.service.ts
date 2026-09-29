import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
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
import { ShareInvitation } from './entities/share-invitation.entity';
import { CreateShareInvitationDto } from './dto/create-share-invitation.dto';

@Injectable()
export class SharingService {
  constructor(
    @InjectRepository(ResourceShare) private readonly shares: Repository<ResourceShare>,
    @InjectRepository(VirtualNode) private readonly nodes: Repository<VirtualNode>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(ShareInvitation) private readonly invitations: Repository<ShareInvitation>,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
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
    if (term.length < 2) throw new BadRequestException('Search must contain at least two characters');
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

  async createInvitation(ownerUserId: string, dto: CreateShareInvitationDto) {
    await this.permissions.requireOwner(ownerUserId, dto.nodeId);
    const node = await this.nodes.findOne({ where: { id: dto.nodeId, userId: ownerUserId, deletedAt: IsNull() } });
    if (!node) throw new NotFoundException('Virtual node not found');
    const email = dto.email.trim().toLowerCase();
    const existingUser = await this.users.findOne({ where: { email, status: UserStatus.ACTIVE } });
    if (existingUser) throw new ConflictException('This person already has a CloudFusion account; create a direct share instead');

    const configuredDays = Number(this.config.get<string | number>('SHARE_INVITATION_EXPIRY_DAYS') ?? 7);
    const expiryDays = Number.isFinite(configuredDays) && configuredDays > 0 ? Math.min(30, configuredDays) : 7;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);
    const invitation = await this.invitations.save(this.invitations.create({
      email,
      nodeId: node.id,
      ownerUserId,
      role: dto.role,
      tokenHash: this.hashInvitationToken(token),
      expiresAt,
      acceptedAt: null,
      revokedAt: null,
    }));
    await this.audit.record(ownerUserId, 'RESOURCE_SHARE_INVITATION_CREATED', 'VirtualNode', node.id, {
      invitationId: invitation.id,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
    });
    // The token is returned once because no email transport is configured yet; only its hash is persisted.
    return { id: invitation.id, email: invitation.email, role: invitation.role, token, expiresAt: invitation.expiresAt };
  }

  async listInvitations(ownerUserId: string, query: ShareListQueryDto) {
    const [invitations, total] = await this.invitations.findAndCount({
      where: { ownerUserId },
      order: { createdAt: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const nodes = invitations.length
      ? await this.nodes.find({ where: [...new Set(invitations.map((invitation) => invitation.nodeId))].map((id) => ({ id })) })
      : [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return {
      items: invitations.map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        node: nodeById.has(invitation.nodeId) ? { id: invitation.nodeId, name: nodeById.get(invitation.nodeId)!.name } : null,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        acceptedAt: invitation.acceptedAt,
        revokedAt: invitation.revokedAt,
        createdAt: invitation.createdAt,
      })),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async revokeInvitation(ownerUserId: string, invitationId: string) {
    const invitation = await this.invitations.findOne({ where: { id: invitationId, ownerUserId } });
    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) throw new GoneException('Invitation is no longer pending');
    invitation.revokedAt = new Date();
    await this.invitations.save(invitation);
    await this.audit.record(ownerUserId, 'RESOURCE_SHARE_INVITATION_REVOKED', 'VirtualNode', invitation.nodeId, { invitationId });
    return { revoked: true };
  }

  async acceptInvitation(userId: string, token: string) {
    if (token.length < 32 || token.length > 128) throw new NotFoundException('Invitation not found');
    const tokenHash = this.hashInvitationToken(token);
    const accepted = await this.dataSource.transaction(async (manager) => {
      const invitationRepository = manager.getRepository(ShareInvitation);
      const invitation = await invitationRepository.createQueryBuilder('invitation')
        .setLock('pessimistic_write')
        .where('invitation.tokenHash = :tokenHash', { tokenHash })
        .getOne();
      if (!invitation) throw new NotFoundException('Invitation not found');
      if (invitation.acceptedAt || invitation.revokedAt) throw new GoneException('Invitation is no longer pending');
      if (invitation.expiresAt <= new Date()) throw new GoneException('Invitation has expired');

      const user = await manager.getRepository(User).findOne({ where: { id: userId, status: UserStatus.ACTIVE } });
      if (!user || user.email.toLowerCase() !== invitation.email.toLowerCase()) {
        throw new ForbiddenException('This invitation belongs to a different email address');
      }
      const node = await manager.getRepository(VirtualNode).findOne({ where: { id: invitation.nodeId, userId: invitation.ownerUserId, deletedAt: IsNull() } });
      if (!node) throw new GoneException('Shared resource is no longer available');

      const shareRepository = manager.getRepository(ResourceShare);
      let share = await shareRepository.findOne({ where: { nodeId: node.id, sharedWithUserId: user.id } });
      if (share) {
        share.ownerUserId = invitation.ownerUserId;
        share.role = invitation.role;
        share.status = ResourceShareStatus.ACTIVE;
        share.revokedAt = null;
      } else {
        share = shareRepository.create({
          ownerUserId: invitation.ownerUserId,
          nodeId: node.id,
          sharedWithUserId: user.id,
          role: invitation.role,
          status: ResourceShareStatus.ACTIVE,
          revokedAt: null,
        });
      }
      share = await shareRepository.save(share);
      invitation.acceptedAt = new Date();
      await invitationRepository.save(invitation);
      return { share, node };
    });
    await this.audit.record(userId, 'RESOURCE_SHARE_INVITATION_ACCEPTED', 'VirtualNode', accepted.node.id, { ownerUserId: accepted.share.ownerUserId, shareId: accepted.share.id });
    return this.toShareResponse(accepted.share, accepted.node);
  }

  private hashInvitationToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
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
