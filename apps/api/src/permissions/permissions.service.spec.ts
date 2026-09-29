import { DataSource } from 'typeorm';
import { PermissionsService } from './permissions.service';

describe('PermissionsService', () => {
  const fixture = () => {
    const dataSource = { query: jest.fn() };
    return { service: new PermissionsService(dataSource as unknown as DataSource), dataSource };
  };

  it.each([
    ['owner', 'OWNER', true, true],
    ['editor', 'EDITOR', true, true],
    ['viewer', 'VIEWER', true, false],
    ['unshared user', 'NONE', false, false],
  ])('maps %s to read/write capabilities', async (_label, permission, canRead, canWrite) => {
    const { service, dataSource } = fixture();
    dataSource.query.mockResolvedValue([{ permission }]);

    await expect(service.canRead('user-id', 'node-id')).resolves.toBe(canRead);
    dataSource.query.mockResolvedValue([{ permission }]);
    await expect(service.canWrite('user-id', 'node-id')).resolves.toBe(canWrite);
  });

  it('uses one recursive query so inherited folder shares are resolved from the database', async () => {
    const { service, dataSource } = fixture();
    dataSource.query.mockResolvedValue([{ permission: 'EDITOR' }]);

    await expect(service.effectivePermission('recipient-id', 'child-id')).resolves.toBe('EDITOR');
    expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining('WITH RECURSIVE ancestors'), ['child-id', 'recipient-id']);
    expect(dataSource.query.mock.calls[0][0]).toContain("shares.status = 'ACTIVE'");
    expect(dataSource.query.mock.calls[0][0]).toContain('shares.revoked_at IS NULL');
  });

  it('resolves workspace roles from membership without treating the storage owner as an implicit owner', async () => {
    const { service, dataSource } = fixture();
    dataSource.query.mockResolvedValue([{ permission: 'MANAGER' }]);

    await expect(service.canShare('admin-id', 'workspace-node-id')).resolves.toBe(true);
    const sql = dataSource.query.mock.calls[0][0] as string;
    expect(sql).toContain('workspace_members');
    expect(sql).toContain("WHEN 'ADMIN' THEN 'MANAGER'");
    expect(sql).toContain('WHEN (SELECT workspace_id FROM ancestors WHERE depth = 0) IS NULL');
  });

  it('denies access when the node does not exist or is in trash', async () => {
    const { service, dataSource } = fixture();
    dataSource.query.mockResolvedValue([]);

    await expect(service.canRead('user-id', 'missing-node')).resolves.toBe(false);
  });
});
