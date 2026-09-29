import { ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { PublicSharesService } from './public-shares.service';
import { PublicShare, PublicSharePermission } from './entities/public-share.entity';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';

function queryBuilder(result: unknown) {
  return {
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
}

function fixture() {
  const shares = {
    createQueryBuilder: jest.fn(),
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
    findOne: jest.fn(),
  };
  const nodes = { findOne: jest.fn(), find: jest.fn() };
  const users = { findOne: jest.fn() };
  const permissions = { requireOwner: jest.fn() };
  const audit = { record: jest.fn() };
  const dataSource = { query: jest.fn() };
  const config = { get: jest.fn((key: string) => key === 'app.frontendUrl' ? 'http://localhost:4200' : 7) };
  const drive = { download: jest.fn() };
  const service = new PublicSharesService(shares as never, nodes as never, users as never, permissions as never, audit as never, dataSource as never, config as never, drive as never);
  return { service, shares, nodes, users, permissions, audit, dataSource, config, drive };
}

describe('PublicSharesService', () => {
  it('creates a high-entropy link and stores only the token hash', async () => {
    const data = fixture();
    data.nodes.findOne.mockResolvedValue({ id: 'file-id', userId: 'owner-id', name: 'report.pdf', type: VirtualNodeType.FILE, mimeType: 'application/pdf', size: '1024' });
    data.shares.save.mockImplementation(async (value: Record<string, unknown>) => ({ ...value, id: 'share-id', createdAt: new Date() }));

    const result = await data.service.create('owner-id', { nodeId: 'file-id', permission: PublicSharePermission.DOWNLOAD });
    const saved = data.shares.save.mock.calls[0][0] as PublicShare;

    expect(data.permissions.requireOwner).toHaveBeenCalledWith('owner-id', 'file-id');
    expect(result.token).toHaveLength(43);
    expect(result.url).toBe(`http://localhost:4200/s/${result.token}`);
    expect(saved.tokenHash).toBe(createHash('sha256').update(result.token).digest('hex'));
    expect(saved.tokenHash).not.toBe(result.token);
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('tokenHash');
  });

  it('uses the configured default expiry when a client omits the expiry option', async () => {
    const data = fixture();
    data.config.get.mockImplementation((key: string) => key === 'app.frontendUrl' ? 'http://localhost:4200' : 14);
    data.nodes.findOne.mockResolvedValue({ id: 'file-id', userId: 'owner-id', name: 'report.pdf', type: VirtualNodeType.FILE, mimeType: 'application/pdf', size: '1024' });
    data.shares.save.mockImplementation(async (value: Record<string, unknown>) => ({ ...value, id: 'share-id', createdAt: new Date() }));
    const before = Date.now();

    await data.service.create('owner-id', { nodeId: 'file-id', permission: PublicSharePermission.DOWNLOAD });

    const saved = data.shares.save.mock.calls[0][0] as PublicShare;
    expect(saved.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 14 * 24 * 60 * 60 * 1000);
    expect(saved.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + 14 * 24 * 60 * 60 * 1000);
  });

  it('returns only safe public metadata and hides all file details until a password is supplied', async () => {
    const data = fixture();
    const protectedShare = { id: 'share-id', tokenHash: 'hash', ownerUserId: 'owner-id', nodeId: 'file-id', passwordHash: 'argon-hash', enabled: true, revokedAt: null, expiresAt: null, downloadCount: 0, downloadLimit: null };
    data.shares.createQueryBuilder.mockReturnValue(queryBuilder(protectedShare));

    await expect(data.service.publicInfo('A'.repeat(43))).resolves.toEqual({ passwordRequired: true });
    expect(data.nodes.findOne).not.toHaveBeenCalled();
  });

  it('reveals safe metadata only after verifying a protected link password', async () => {
    const data = fixture();
    const protectedShare = { id: 'share-id', ownerUserId: 'owner-id', nodeId: 'file-id', passwordHash: await argon2.hash('correct-password'), enabled: true, revokedAt: null, expiresAt: null, downloadCount: 0, downloadLimit: null, permission: PublicSharePermission.VIEW_ONLY };
    data.shares.createQueryBuilder.mockReturnValue(queryBuilder(protectedShare));
    data.nodes.findOne.mockResolvedValue({ id: 'file-id', userId: 'owner-id', name: 'plan.pdf', type: VirtualNodeType.FILE, mimeType: 'application/pdf', size: '64' });
    data.users.findOne.mockResolvedValue({ id: 'owner-id', username: 'owner' });

    const result = await data.service.publicInfo('A'.repeat(43), 'correct-password');

    expect(result).toEqual(expect.objectContaining({ passwordRequired: false, ownerName: 'owner', resource: expect.objectContaining({ name: 'plan.pdf' }) }));
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('ownerEmail');
    expect(result).not.toHaveProperty('nodeId');
  });

  it('does not reveal protected resource metadata when the password is wrong', async () => {
    const data = fixture();
    const protectedShare = { id: 'share-id', ownerUserId: 'owner-id', nodeId: 'file-id', passwordHash: await argon2.hash('correct-password'), enabled: true, revokedAt: null, expiresAt: null, downloadCount: 0, downloadLimit: null };
    data.shares.createQueryBuilder.mockReturnValue(queryBuilder(protectedShare));

    await expect(data.service.publicInfo('E'.repeat(43), 'incorrect-password')).rejects.toBeInstanceOf(NotFoundException);
    expect(data.nodes.findOne).not.toHaveBeenCalled();
  });

  it('rejects unknown or expired tokens without disclosing resource information', async () => {
    const data = fixture();
    const query = queryBuilder(null);
    data.shares.createQueryBuilder.mockReturnValue(query);

    await expect(data.service.publicInfo('B'.repeat(43))).rejects.toBeInstanceOf(NotFoundException);
    expect(query.andWhere).toHaveBeenCalledWith('share.enabled = true');
    expect(query.andWhere).toHaveBeenCalledWith('share.revokedAt IS NULL');
  });

  it('rejects an expired link even if a stale row is returned by the repository', async () => {
    const data = fixture();
    data.shares.createQueryBuilder.mockReturnValue(queryBuilder({
      id: 'share-id', enabled: true, revokedAt: null, expiresAt: new Date(Date.now() - 1000), downloadCount: 0, downloadLimit: null,
    }));

    await expect(data.service.publicInfo('F'.repeat(43))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('increments download quota atomically before serving a file', async () => {
    const data = fixture();
    const share = {
      id: 'share-id', tokenHash: 'hash', ownerUserId: 'owner-id', nodeId: 'file-id', passwordHash: null,
      enabled: true, revokedAt: null, permission: PublicSharePermission.DOWNLOAD,
      expiresAt: new Date(Date.now() + 60_000), downloadCount: 0, downloadLimit: 1,
    };
    data.shares.createQueryBuilder.mockReturnValue(queryBuilder(share));
    data.dataSource.query.mockResolvedValue([{ id: 'share-id' }]);
    const download = { fileName: 'report.pdf', mimeType: 'application/pdf', size: 1024, stream: {} };
    data.drive.download.mockResolvedValue(download);

    await expect(data.service.download('C'.repeat(43), {})).resolves.toBe(download);

    expect(data.dataSource.query).toHaveBeenCalledWith(expect.stringContaining('download_count = download_count + 1'), ['share-id']);
    expect(data.dataSource.query.mock.calls[0][0]).toContain('download_count < download_limit');
    expect(data.drive.download).toHaveBeenCalledWith('owner-id', 'file-id');
    expect(data.audit.record).toHaveBeenCalledWith('owner-id', 'PUBLIC_LINK_DOWNLOADED', 'VirtualNode', 'file-id', { publicShareId: 'share-id' });
  });

  it('refuses a concurrent download when the quota was consumed by another request', async () => {
    const data = fixture();
    const share = {
      id: 'share-id', ownerUserId: 'owner-id', nodeId: 'file-id', passwordHash: null,
      enabled: true, revokedAt: null, permission: PublicSharePermission.DOWNLOAD,
      expiresAt: null, downloadCount: 0, downloadLimit: 1,
    };
    data.shares.createQueryBuilder.mockReturnValue(queryBuilder(share));
    data.dataSource.query.mockResolvedValue([]);

    await expect(data.service.download('D'.repeat(43), {})).rejects.toBeInstanceOf(GoneException);
    expect(data.drive.download).not.toHaveBeenCalled();
  });

  it('refuses downloads for a view-only link', async () => {
    const data = fixture();
    data.shares.createQueryBuilder.mockReturnValue(queryBuilder({
      id: 'share-id', ownerUserId: 'owner-id', nodeId: 'file-id', passwordHash: null,
      enabled: true, revokedAt: null, permission: PublicSharePermission.VIEW_ONLY,
      expiresAt: null, downloadCount: 0, downloadLimit: null,
    }));

    await expect(data.service.download('G'.repeat(43), {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(data.dataSource.query).not.toHaveBeenCalled();
    expect(data.drive.download).not.toHaveBeenCalled();
  });

  it('releases the reserved download quota if the underlying file cannot be retrieved', async () => {
    const data = fixture();
    data.shares.createQueryBuilder.mockReturnValue(queryBuilder({
      id: 'share-id', ownerUserId: 'owner-id', nodeId: 'file-id', passwordHash: null,
      enabled: true, revokedAt: null, permission: PublicSharePermission.DOWNLOAD,
      expiresAt: null, downloadCount: 0, downloadLimit: 3,
    }));
    data.dataSource.query.mockResolvedValue([{ id: 'share-id' }]);
    const failure = new Error('storage unavailable');
    data.drive.download.mockRejectedValue(failure);

    await expect(data.service.download('H'.repeat(43), {})).rejects.toBe(failure);
    expect(data.dataSource.query).toHaveBeenNthCalledWith(2, 'UPDATE public_shares SET download_count = GREATEST(download_count - 1, 0) WHERE id = $1', ['share-id']);
  });
});
