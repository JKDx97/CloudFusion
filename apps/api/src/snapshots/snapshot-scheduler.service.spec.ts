import { SnapshotSchedulerService } from './snapshot-scheduler.service';

describe('SnapshotSchedulerService', () => {
  it('creates one protected daily snapshot per active user after the UTC schedule time', async () => {
    const nodes = { find: jest.fn().mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-1' }]) };
    const saved = new Set<string>();
    const snapshots = { findOne: jest.fn(async ({ where }: { where: { description: string } }) => saved.has(where.description) ? { id: 'snapshot-1' } : null) };
    const snapshotService = { create: jest.fn(async (_userId: string, dto: { description?: string }) => { saved.add(dto.description ?? ''); return { id: 'snapshot-1' }; }) };
    const config = { get: jest.fn(() => true) };
    const service = new SnapshotSchedulerService(config as never, nodes as never, snapshots as never, snapshotService as never);

    await expect(service.runDueSnapshots(new Date('2026-09-28T02:59:00Z'))).resolves.toBe(0);
    await expect(service.runDueSnapshots(new Date('2026-09-28T03:01:00Z'))).resolves.toBe(1);
    await expect(service.runDueSnapshots(new Date('2026-09-28T03:02:00Z'))).resolves.toBe(0);
    expect(snapshotService.create).toHaveBeenCalledTimes(1);
    expect(snapshotService.create).toHaveBeenCalledWith('user-1', expect.objectContaining({ isImmutable: true, description: 'scheduled:daily:2026-09-28' }));
  });
});
