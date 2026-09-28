import { ProtectionService } from './protection.service';
import { ProtectionAlert } from './entities/protection-alert.entity';

describe('ProtectionService mass-change detection', () => {
  it('creates one warning and an emergency snapshot after the threshold is exceeded', async () => {
    const alertRepository = {
      create: jest.fn((value: Partial<ProtectionAlert>) => value),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(async (value: Partial<ProtectionAlert>) => Object.assign(value, { id: 'alert-1', createdAt: new Date() })),
      find: jest.fn(),
      count: jest.fn(),
    };
    const auditLogQuery = {
      select: jest.fn().mockReturnThis(), addSelect: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(), groupBy: jest.fn().mockReturnThis(), having: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(), getRawMany: jest.fn().mockResolvedValue([{ userId: 'user-1', eventCount: '20' }]),
    };
    const auditLogs = { createQueryBuilder: jest.fn(() => auditLogQuery) };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn((entity: unknown) => entity === ProtectionAlert ? alertRepository : alertRepository),
    };
    const dataSource = { transaction: jest.fn((callback: (value: unknown) => Promise<unknown>) => callback(manager)) };
    const config = { get: jest.fn((key: string) => ({
      'dataProtection.massChangeWindowSeconds': 120,
      'dataProtection.massChangeThreshold': 10,
      'dataProtection.emergencySnapshotEnabled': true,
    } as Record<string, unknown>)[key]) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const snapshots = { create: jest.fn().mockResolvedValue({ id: 'snapshot-emergency' }) };
    const service = new ProtectionService(
      alertRepository as never, auditLogs as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, dataSource as never, config as never, audit as never, snapshots as never,
    );

    await expect(service.scanMassChanges()).resolves.toBe(1);
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['mass-change:user-1']);
    expect(alertRepository.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', kind: 'MASS_FILE_CHANGE', eventCount: 20 }));
    expect(snapshots.create).toHaveBeenCalledWith('user-1', expect.objectContaining({ isImmutable: true }));
    expect(audit.record).toHaveBeenCalledWith('user-1', 'MASS_CHANGE_DETECTED', 'ProtectionAlert', 'alert-1', expect.any(Object));
  });
});
