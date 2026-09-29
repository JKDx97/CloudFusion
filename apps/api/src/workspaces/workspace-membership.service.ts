import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { AcceptWorkspaceInvitationDto } from './dto/accept-workspace-invitation.dto';
import { CreateWorkspaceInvitationDto } from './dto/create-workspace-invitation.dto';
import { UpdateWorkspaceMemberDto } from './dto/update-workspace-member.dto';
import { WorkspaceInvitation } from './entities/workspace-invitation.entity';
import { WorkspaceMember, WorkspaceRole } from './entities/workspace-member.entity';

@Injectable()
export class WorkspaceMembershipService {
  constructor(
    @InjectRepository(WorkspaceMember) private readonly members: Repository<WorkspaceMember>,
    @InjectRepository(WorkspaceInvitation) private readonly invitations: Repository<WorkspaceInvitation>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async listMembers(actorUserId: string, workspaceId: string, page = 1, limit = 25) {
    await this.requireMember(actorUserId, workspaceId);
    const [members, total] = await this.members.findAndCount({
      where: { workspaceId },
      order: { joinedAt: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const userIds = members.map((member) => member.userId);
    const users = userIds.length
      ? await this.users.find({ where: { id: In(userIds) }, select: { id: true, email: true, username: true } })
      : [];
    const usersById = new Map(users.map((user) => [user.id, user]));
    return {
      items: members.map((member) => ({
        user: usersById.get(member.userId) ?? null,
        role: member.role,
        joinedAt: member.joinedAt,
      })),
      page,
      limit,
      total,
    };
  }

  async updateMemberRole(actorUserId: string, workspaceId: string, targetUserId: string, dto: UpdateWorkspaceMemberDto) {
    const actor = await this.requireManager(actorUserId, workspaceId);
    if (dto.role === WorkspaceRole.OWNER) throw new ForbiddenException('Ownership can only be changed through ownership transfer');
    const target = await this.members.findOne({ where: { workspaceId, userId: targetUserId } });
    if (!target) throw new NotFoundException('Workspace member not found');
    if (target.role === WorkspaceRole.OWNER) throw new ForbiddenException('The workspace owner cannot be demoted');
    if (actor.role === WorkspaceRole.ADMIN && (target.role === WorkspaceRole.ADMIN || dto.role === WorkspaceRole.ADMIN)) {
      throw new ForbiddenException('Workspace admins cannot manage owner or admin roles');
    }
    const oldRole = target.role;
    target.role = dto.role;
    await this.members.save(target);
    await this.audit.record(actorUserId, 'WORKSPACE_MEMBER_ROLE_CHANGED', 'Workspace', workspaceId, { targetUserId, oldRole, newRole: target.role });
    return { userId: targetUserId, role: target.role };
  }

  async removeMember(actorUserId: string, workspaceId: string, targetUserId: string) {
    const actor = await this.requireManager(actorUserId, workspaceId);
    const target = await this.members.findOne({ where: { workspaceId, userId: targetUserId } });
    if (!target) throw new NotFoundException('Workspace member not found');
    if (target.role === WorkspaceRole.OWNER) throw new ForbiddenException('Transfer workspace ownership before removing its owner');
    if (actor.role === WorkspaceRole.ADMIN && target.role === WorkspaceRole.ADMIN) {
      throw new ForbiddenException('Workspace admins cannot remove another admin');
    }
    await this.members.delete({ workspaceId, userId: targetUserId });
    await this.audit.record(actorUserId, 'WORKSPACE_MEMBER_REMOVED', 'Workspace', workspaceId, { targetUserId, role: target.role });
    return { removed: true };
  }

  async leave(actorUserId: string, workspaceId: string) {
    const member = await this.members.findOne({ where: { workspaceId, userId: actorUserId } });
    if (!member) throw new NotFoundException('Workspace membership not found');
    if (member.role === WorkspaceRole.OWNER) throw new ForbiddenException('Transfer ownership or delete the workspace before leaving');
    await this.members.delete({ workspaceId, userId: actorUserId });
    await this.audit.record(actorUserId, 'WORKSPACE_MEMBER_LEFT', 'Workspace', workspaceId, {});
    return { left: true };
  }

  async createInvitation(actorUserId: string, workspaceId: string, dto: CreateWorkspaceInvitationDto) {
    const actor = await this.requireManager(actorUserId, workspaceId);
    if (![WorkspaceRole.ADMIN, WorkspaceRole.MEMBER, WorkspaceRole.VIEWER].includes(dto.role)) {
      throw new ForbiddenException('Cannot invite a member with the requested role');
    }
    if (actor.role === WorkspaceRole.ADMIN && dto.role === WorkspaceRole.ADMIN) {
      throw new ForbiddenException('Only the workspace owner can invite another admin');
    }

    const email = dto.email.trim().toLowerCase();
    const existingUser = await this.users.findOne({ where: { email, status: UserStatus.ACTIVE }, select: { id: true } });
    if (existingUser && await this.members.findOne({ where: { workspaceId, userId: existingUser.id } })) {
      throw new ConflictException('This user is already a workspace member');
    }

    const previous = await this.invitations.findOne({ where: { workspaceId, email, acceptedAt: IsNull(), revokedAt: IsNull() } });
    if (previous && previous.expiresAt > new Date()) throw new ConflictException('An active invitation already exists for this email');
    if (previous) {
      previous.revokedAt = new Date();
      await this.invitations.save(previous);
    }

    const token = randomBytes(32).toString('base64url');
    const configuredDays = Number(this.config.get<string | number>('WORKSPACE_INVITATION_EXPIRY_DAYS') ?? this.config.get<string | number>('SHARE_INVITATION_EXPIRY_DAYS') ?? 7);
    const expiryDays = Number.isSafeInteger(configuredDays) && configuredDays > 0 && configuredDays <= 30 ? configuredDays : 7;
    let invitation: WorkspaceInvitation;
    try {
      invitation = await this.invitations.save(this.invitations.create({
        workspaceId,
        inviterUserId: actorUserId,
        email,
        role: dto.role,
        tokenHash: this.hashToken(token),
        expiresAt: new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000),
        acceptedAt: null,
        revokedAt: null,
      }));
    } catch (error) {
      if ((error as { driverError?: { code?: string } })?.driverError?.code === '23505') {
        throw new ConflictException('An active invitation already exists for this email');
      }
      throw error;
    }

    await this.audit.record(actorUserId, 'WORKSPACE_MEMBER_INVITED', 'Workspace', workspaceId, { invitationId: invitation.id, role: invitation.role });
    return { ...this.toSafeInvitation(invitation), token };
  }

  async listInvitations(actorUserId: string, workspaceId: string, page = 1, limit = 25) {
    await this.requireManager(actorUserId, workspaceId);
    const [invitations, total] = await this.invitations.findAndCount({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items: invitations.map((invitation) => this.toSafeInvitation(invitation)), page, limit, total };
  }

  async revokeInvitation(actorUserId: string, workspaceId: string, invitationId: string) {
    await this.requireManager(actorUserId, workspaceId);
    const invitation = await this.invitations.findOne({ where: { id: invitationId, workspaceId } });
    if (!invitation) throw new NotFoundException('Workspace invitation not found');
    if (invitation.acceptedAt || invitation.revokedAt) return { revoked: true };
    invitation.revokedAt = new Date();
    await this.invitations.save(invitation);
    await this.audit.record(actorUserId, 'WORKSPACE_INVITATION_REVOKED', 'Workspace', workspaceId, { invitationId });
    return { revoked: true };
  }

  async acceptInvitation(userId: string, dto: AcceptWorkspaceInvitationDto) {
    const user = await this.users.findOne({ where: { id: userId, status: UserStatus.ACTIVE }, select: { id: true, email: true } });
    if (!user) throw new NotFoundException('Workspace invitation not found');
    const tokenHash = this.hashToken(dto.token);
    const joined = await this.dataSource.transaction(async (manager) => {
      const invitationRepository = manager.getRepository(WorkspaceInvitation);
      const memberRepository = manager.getRepository(WorkspaceMember);
      const invitation = await invitationRepository.createQueryBuilder('invitation')
        .setLock('pessimistic_write')
        .where('invitation.tokenHash = :tokenHash', { tokenHash })
        .getOne();
      if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
        throw new NotFoundException('Workspace invitation not found');
      }
      if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
        throw new NotFoundException('Workspace invitation not found');
      }

      let membership = await memberRepository.findOne({ where: { workspaceId: invitation.workspaceId, userId } });
      const newlyJoined = !membership;
      if (!membership) {
        membership = await memberRepository.save(memberRepository.create({
          workspaceId: invitation.workspaceId,
          userId,
          role: invitation.role,
        }));
      }
      invitation.acceptedAt = new Date();
      await invitationRepository.save(invitation);
      return { membership, newlyJoined, workspaceId: invitation.workspaceId };
    });

    if (joined.newlyJoined) {
      await this.audit.record(userId, 'WORKSPACE_MEMBER_JOINED', 'Workspace', joined.workspaceId, { role: joined.membership.role });
    }
    return { workspaceId: joined.workspaceId, userId, role: joined.membership.role, joinedAt: joined.membership.joinedAt };
  }

  private async requireMember(userId: string, workspaceId: string): Promise<WorkspaceMember> {
    const member = await this.members.findOne({ where: { workspaceId, userId } });
    if (!member) throw new NotFoundException('Workspace not found');
    return member;
  }

  private async requireManager(userId: string, workspaceId: string): Promise<WorkspaceMember> {
    const member = await this.requireMember(userId, workspaceId);
    if (member.role !== WorkspaceRole.OWNER && member.role !== WorkspaceRole.ADMIN) {
      throw new ForbiddenException('Workspace owner or admin role required');
    }
    return member;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toSafeInvitation(invitation: WorkspaceInvitation) {
    return {
      id: invitation.id,
      workspaceId: invitation.workspaceId,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      revokedAt: invitation.revokedAt,
      createdAt: invitation.createdAt,
    };
  }
}
