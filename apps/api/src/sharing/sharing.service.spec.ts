import { NotFoundException } from '@nestjs/common';
import { SharingService } from './sharing.service';
import { ResourceShareRole, ResourceShareStatus } from '../permissions/entities/resource-share.entity';
import { UserStatus } from '../users/entities/user.entity';
import { ShareInvitation } from './entities/share-invitation.entity';
import { User } from '../users/entities/user.entity';
import { createHash } from 'node:crypto';

function fixture() {
  const shares = {
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
  };
  const invitations = {
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
    createQueryBuilder: jest.fn(),
  };
  const nodes = { findOne: jest.fn(), find: jest.fn() };
  const userQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
  };
  const users = {
    findOne: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn(() => userQuery),
  };
  const permissions = { requireOwner: jest.fn() };
  const audit = { record: jest.fn() };
  const dataSource = { transaction: jest.fn() };
  const config = { get: jest.fn(() => 7) };
  const service = new SharingService(shares as never, nodes as never, users as never, invitations as never, permissions as never, audit as never, dataSource as never, config as never);
  return { service, shares, invitations, nodes, users, userQuery, permissions, audit, dataSource, config };
}

describe('SharingService', () => {
  it('creates an active share for an existing user without returning internal node data', async () => {
    const data = fixture();
    const node = { id: 'node-id', userId: 'owner-id', name: 'project', type: 'FOLDER', mimeType: 'inode/directory', size: null, parentId: null };
    const recipient = { id: 'recipient-id', email: 'ana@example.com', username: 'ana' };
    data.nodes.findOne.mockResolvedValue(node);
    data.users.findOne.mockResolvedValue(recipient);
    data.shares.findOne.mockResolvedValue(null);
    data.shares.save.mockImplementation(async (value: Record<string, unknown>) => ({ ...value, id: 'share-id', createdAt: new Date(), updatedAt: new Date() }));

    const result = await data.service.create('owner-id', {
      nodeId: 'node-id', email: 'ANA@example.com', role: ResourceShareRole.VIEWER,
    });

    expect(data.permissions.requireOwner).toHaveBeenCalledWith('owner-id', 'node-id');
    expect(data.users.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'ana@example.com', status: UserStatus.ACTIVE } }));
    expect(result).toEqual(expect.objectContaining({
      id: 'share-id',
      role: ResourceShareRole.VIEWER,
      user: recipient,
      node: expect.objectContaining({ id: 'node-id', name: 'project' }),
    }));
    expect(result.node).not.toHaveProperty('userId');
    expect(result.node).not.toHaveProperty('storageObjectId');
    expect(data.audit.record).toHaveBeenCalledWith('owner-id', 'RESOURCE_SHARED', 'VirtualNode', 'node-id', expect.objectContaining({ recipientUserId: 'recipient-id' }));
  });

  it('does not reveal or create shares when the requested node is not owned', async () => {
    const data = fixture();
    data.permissions.requireOwner.mockRejectedValue(new NotFoundException());

    await expect(data.service.create('attacker-id', {
      nodeId: 'victim-node', email: 'victim@example.com', role: ResourceShareRole.EDITOR,
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(data.nodes.findOne).not.toHaveBeenCalled();
    expect(data.shares.save).not.toHaveBeenCalled();
  });

  it('reactivates a previously revoked share instead of creating duplicates', async () => {
    const data = fixture();
    const share = { id: 'share-id', ownerUserId: 'owner-id', nodeId: 'node-id', sharedWithUserId: 'recipient-id', role: ResourceShareRole.VIEWER, status: ResourceShareStatus.REVOKED, revokedAt: new Date() };
    data.nodes.findOne.mockResolvedValue({ id: 'node-id', userId: 'owner-id', name: 'file.txt', type: 'FILE', mimeType: 'text/plain', size: '12', parentId: 'parent-id' });
    data.users.findOne.mockResolvedValue({ id: 'recipient-id', email: 'ana@example.com', username: 'ana' });
    data.shares.findOne.mockResolvedValue(share);
    data.shares.save.mockImplementation(async (value: unknown) => value);

    const result = await data.service.create('owner-id', { nodeId: 'node-id', email: 'ana@example.com', role: ResourceShareRole.EDITOR });

    expect(data.shares.create).not.toHaveBeenCalled();
    expect(share).toMatchObject({ role: ResourceShareRole.EDITOR, status: ResourceShareStatus.ACTIVE, revokedAt: null });
    expect(result.status).toBe(ResourceShareStatus.ACTIVE);
  });

  it('immediately marks revoked shares inactive', async () => {
    const data = fixture();
    const share = { id: 'share-id', ownerUserId: 'owner-id', nodeId: 'node-id', status: ResourceShareStatus.ACTIVE, revokedAt: null };
    data.shares.findOne.mockResolvedValue(share);

    await expect(data.service.revoke('owner-id', 'share-id')).resolves.toEqual({ revoked: true });

    expect(share.status).toBe(ResourceShareStatus.REVOKED);
    expect(share.revokedAt).toBeInstanceOf(Date);
    expect(data.audit.record).toHaveBeenCalledWith('owner-id', 'RESOURCE_SHARE_REVOKED', 'VirtualNode', 'node-id', { shareId: 'share-id' });
  });

  it('searches username prefixes safely and returns only limited public identity fields', async () => {
    const data = fixture();
    data.userQuery.getManyAndCount.mockResolvedValue([[{ id: 'other-id', username: 'anna', email: 'anna@example.com' }], 1]);

    const result = await data.service.searchUsers('owner-id', { q: 'an', page: 1, limit: 10 });

    expect(data.userQuery.andWhere).toHaveBeenCalledWith('user.username ILIKE :username', { username: 'an%' });
    expect(result.items).toEqual([{ id: 'other-id', username: 'anna', email: 'anna@example.com' }]);
    expect(result.items[0]).not.toHaveProperty('passwordHash');
  });

  it('does not treat wildcard characters as a directory search', async () => {
    const data = fixture();

    await expect(data.service.searchUsers('owner-id', { q: 'a%', page: 1, limit: 10 })).resolves.toEqual({
      items: [], page: 1, limit: 10, total: 0,
    });
    expect(data.userQuery.getManyAndCount).not.toHaveBeenCalled();
  });

  it('creates a seven-day invitation and returns a token while storing only its SHA-256 hash', async () => {
    const data = fixture();
    data.nodes.findOne.mockResolvedValue({ id: 'node-id', userId: 'owner-id', name: 'Project' });
    data.users.findOne.mockResolvedValue(null);
    data.invitations.save.mockImplementation(async (value: Record<string, unknown>) => ({ ...value, id: 'invitation-id', createdAt: new Date() }));

    const result = await data.service.createInvitation('owner-id', {
      nodeId: 'node-id', email: 'NEW@example.com', role: ResourceShareRole.VIEWER,
    });
    const savedInvitation = data.invitations.save.mock.calls[0][0] as ShareInvitation;

    expect(result.token).toHaveLength(43);
    expect(result.email).toBe('new@example.com');
    expect(savedInvitation.tokenHash).toBe(createHash('sha256').update(result.token).digest('hex'));
    expect(savedInvitation.tokenHash).not.toBe(result.token);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(result.expiresAt.getTime()).toBeLessThan(Date.now() + 8 * 24 * 60 * 60 * 1000);
  });

  it('rejects accepting an invitation from an account with a different email', async () => {
    const data = fixture();
    const invitation = {
      id: 'invitation-id', email: 'target@example.com', nodeId: 'node-id', ownerUserId: 'owner-id',
      role: ResourceShareRole.EDITOR, tokenHash: 'hash', expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null, revokedAt: null,
    };
    const invitationQuery = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(invitation),
    };
    data.invitations.createQueryBuilder.mockReturnValue(invitationQuery);
    data.dataSource.transaction.mockImplementation(async (callback: (manager: unknown) => Promise<unknown>) => callback({
      getRepository: (entity: unknown) => entity === ShareInvitation
        ? data.invitations
        : entity === User
          ? { findOne: jest.fn().mockResolvedValue({ id: 'wrong-user', email: 'other@example.com', status: UserStatus.ACTIVE }) }
          : data.nodes,
    }));

    await expect(data.service.acceptInvitation('wrong-user', 'a'.repeat(43))).rejects.toThrow('different email address');
    expect(data.shares.save).not.toHaveBeenCalled();
    expect(invitationQuery.setLock).toHaveBeenCalledWith('pessimistic_write');
  });
});
