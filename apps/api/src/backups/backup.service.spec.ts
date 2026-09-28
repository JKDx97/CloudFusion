import { BackupService } from './backup.service';
import { BackupPolicy } from './entities/backup-policy.entity';
import { CloudAccountStatus } from '../providers/common/cloud-provider.enum';

describe('BackupService policies', () => {
  it('creates an owned, scheduled, cross-account backup policy with bounded retention', async () => {
    const policyRepository = {
      create: jest.fn((value: Partial<BackupPolicy>) => value),
      save: jest.fn(async (value: Partial<BackupPolicy>) => Object.assign(value, { id: 'policy-1', createdAt: new Date() })),
    };
    const accountService = { getOwnedAccount: jest.fn().mockResolvedValue({ id: 'account-1', status: CloudAccountStatus.CONNECTED }) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new BackupService(
      policyRepository as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, accountService as never, {} as never,
      {} as never, {} as never, audit as never, {} as never,
    );

    const policy = await service.createPolicy('user-1', {
      name: 'Copia semanal', destinationAccountId: 'account-1', schedule: 'WEEKLY', retentionDays: 90,
    });

    expect(policy).toMatchObject({ id: 'policy-1', userId: 'user-1', name: 'Copia semanal', scope: 'DRIVE', mode: 'SNAPSHOT_BACKUP', schedule: 'WEEKLY', retentionDays: 90, enabled: true });
    expect(policy.nextRunAt).toBeInstanceOf(Date);
    expect(accountService.getOwnedAccount).toHaveBeenCalledWith('user-1', 'account-1');
    expect(audit.record).toHaveBeenCalledWith('user-1', 'BACKUP_POLICY_CREATED', 'BackupPolicy', 'policy-1', expect.objectContaining({ schedule: 'WEEKLY' }));
  });

  it('refuses to schedule backups to an account that is not connected', async () => {
    const policyRepository = { create: jest.fn(), save: jest.fn() };
    const accountService = { getOwnedAccount: jest.fn().mockResolvedValue({ id: 'account-1', status: CloudAccountStatus.DISCONNECTED }) };
    const service = new BackupService(
      policyRepository as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, accountService as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );

    await expect(service.createPolicy('user-1', { name: 'Broken', destinationAccountId: 'account-1' })).rejects.toThrow('Backup destination must be connected');
    expect(policyRepository.save).not.toHaveBeenCalled();
  });
});
