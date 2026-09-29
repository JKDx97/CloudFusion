import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { WorkspaceInvitation } from './entities/workspace-invitation.entity';
import { WorkspaceMember, WorkspaceRole } from './entities/workspace-member.entity';
import { WorkspaceMembershipService } from './workspace-membership.service';

function fixture() {
  const members = {
    create: jest.fn((value: unknown) => value),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    save: jest.fn(async (value: unknown) => value),
    delete: jest.fn(),
  };
  const invitations = {
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: Record<string, unknown>) => ({ ...value, id: 'invitation-id', createdAt: new Date() })),
    createQueryBuilder: jest.fn(),
  };
  const users = { findOne: jest.fn(), find: jest.fn() };
  const query = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };
  invitations.createQueryBuilder.mockReturnValue(query);
  const manager = {
    getRepository: jest.fn((entity: unknown) => entity === WorkspaceInvitation ? invitations : members),
  };
  const dataSource = {
    transaction: jest.fn(async (work: (manager: typeof manager) => Promise<unknown>) => work(manager)),
  };
  const config = { get: jest.fn(() => 7) };
  const audit = { record: jest.fn() };
  const service = new WorkspaceMembershipService(members as never, invitations as never, users as never, dataSource as never, config as never, audit as never);
  return { service, members, invitations, users, query, manager, dataSource, config, audit };
}

describe('WorkspaceMembershipService', () => {
  it('lists members only after verifying the requester belongs to the workspace', async () => {
    const data = fixture();
    data.members.findOne.mockResolvedValue({ workspaceId: 'workspace-id', userId: 'viewer-id', role: WorkspaceRole.VIEWER });
    data.members.findAndCount.mockResolvedValue([[{ userId: 'viewer-id', role: WorkspaceRole.VIEWER, joinedAt: new Date() }], 1]);
    data.users.find.mockResolvedValue([{ id: 'viewer-id', username: 'viewer', email: 'viewer@example.com' }]);

    const result = await data.service.listMembers('viewer-id', 'workspace-id', 1, 10);

    expect(data.users.find).toHaveBeenCalledWith(expect.objectContaining({ where: { id: expect.anything() }, select: { id: true, email: true, username: true } }));
    expect(result.items[0]).toEqual(expect.objectContaining({ user: expect.objectContaining({ email: 'viewer@example.com' }), role: WorkspaceRole.VIEWER }));
  });

  it('prevents an admin from promoting members to admin or changing another admin', async () => {
    const data = fixture();
    data.members.findOne.mockResolvedValueOnce({ role: WorkspaceRole.ADMIN }).mockResolvedValueOnce({ role: WorkspaceRole.MEMBER });

    await expect(data.service.updateMemberRole('admin-id', 'workspace-id', 'member-id', { role: WorkspaceRole.ADMIN })).rejects.toBeInstanceOf(ForbiddenException);
    expect(data.members.save).not.toHaveBeenCalled();
  });

  it('does not allow the workspace owner to leave without transferring ownership', async () => {
    const data = fixture();
    data.members.findOne.mockResolvedValue({ role: WorkspaceRole.OWNER });

    await expect(data.service.leave('owner-id', 'workspace-id')).rejects.toBeInstanceOf(ForbiddenException);
    expect(data.members.delete).not.toHaveBeenCalled();
  });

  it('creates a hashed, expiring invitation and returns the token only at creation time', async () => {
    const data = fixture();
    data.members.findOne.mockResolvedValueOnce({ role: WorkspaceRole.OWNER });
    data.users.findOne.mockResolvedValue(null);
    data.invitations.findOne.mockResolvedValue(null);

    const result = await data.service.createInvitation('owner-id', 'workspace-id', { email: ' ANA@example.com ', role: WorkspaceRole.MEMBER });
    const saved = data.invitations.save.mock.calls[0][0] as Record<string, unknown>;

    expect(result.email).toBe('ana@example.com');
    expect(result.token).toHaveLength(43);
    expect(saved.tokenHash).toBe(createHash('sha256').update(result.token).digest('hex'));
    expect(saved.tokenHash).not.toBe(result.token);
    expect(result).not.toHaveProperty('tokenHash');
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a second unexpired invitation for the same workspace and email', async () => {
    const data = fixture();
    data.members.findOne.mockResolvedValue({ role: WorkspaceRole.OWNER });
    data.users.findOne.mockResolvedValue(null);
    data.invitations.findOne.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000) });

    await expect(data.service.createInvitation('owner-id', 'workspace-id', { email: 'ana@example.com', role: WorkspaceRole.MEMBER })).rejects.toBeInstanceOf(ConflictException);
    expect(data.invitations.save).not.toHaveBeenCalled();
  });

  it('does not let a different account accept an invitation', async () => {
    const data = fixture();
    data.users.findOne.mockResolvedValue({ id: 'attacker-id', email: 'attacker@example.com' });
    data.query.getOne.mockResolvedValue({ workspaceId: 'workspace-id', email: 'ana@example.com', role: WorkspaceRole.MEMBER, expiresAt: new Date(Date.now() + 60_000), acceptedAt: null, revokedAt: null });

    await expect(data.service.acceptInvitation('attacker-id', { token: 'A'.repeat(43) })).rejects.toBeInstanceOf(NotFoundException);
    expect(data.members.save).not.toHaveBeenCalled();
  });

  it('accepts a valid invitation atomically for the matching account', async () => {
    const data = fixture();
    data.users.findOne.mockResolvedValue({ id: 'ana-id', email: 'ana@example.com' });
    const invitation = { id: 'invitation-id', workspaceId: 'workspace-id', email: 'ANA@example.com', role: WorkspaceRole.VIEWER, expiresAt: new Date(Date.now() + 60_000), acceptedAt: null, revokedAt: null };
    data.query.getOne.mockResolvedValue(invitation);
    data.members.findOne.mockResolvedValue(null);
    data.members.save.mockImplementation(async (value: Record<string, unknown>) => ({ ...value, joinedAt: new Date() }));

    const result = await data.service.acceptInvitation('ana-id', { token: 'B'.repeat(43) });

    expect(data.query.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(data.members.save).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-id', userId: 'ana-id', role: WorkspaceRole.VIEWER }));
    expect(invitation.acceptedAt).toBeInstanceOf(Date);
    expect(result).toEqual(expect.objectContaining({ workspaceId: 'workspace-id', userId: 'ana-id', role: WorkspaceRole.VIEWER }));
    expect(data.audit.record).toHaveBeenCalledWith('ana-id', 'WORKSPACE_MEMBER_JOINED', 'Workspace', 'workspace-id', { role: WorkspaceRole.VIEWER });
  });

  it('prevents an admin from removing another admin', async () => {
    const data = fixture();
    data.members.findOne.mockResolvedValueOnce({ role: WorkspaceRole.ADMIN }).mockResolvedValueOnce({ role: WorkspaceRole.ADMIN });

    await expect(data.service.removeMember('admin-id', 'workspace-id', 'other-admin-id')).rejects.toBeInstanceOf(ForbiddenException);
    expect(data.members.delete).not.toHaveBeenCalled();
  });
});
