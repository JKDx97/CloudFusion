import { NotFoundException } from '@nestjs/common';
import { SharingService } from './sharing.service';
import { ResourceShareRole, ResourceShareStatus } from '../permissions/entities/resource-share.entity';
import { UserStatus } from '../users/entities/user.entity';

function fixture() {
  const shares = {
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
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
  const service = new SharingService(shares as never, nodes as never, users as never, permissions as never, audit as never);
  return { service, shares, nodes, users, userQuery, permissions, audit };
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
});
