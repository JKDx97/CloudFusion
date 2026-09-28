import { StorageGarbageCollectorService } from './storage-garbage-collector.service';
import { StorageObject } from './entities/storage-object.entity';
import { StorageReplica } from './entities/storage-replica.entity';
import { FileVersion } from './entities/file-version.entity';
import { SnapshotEntry } from '../snapshots/entities/snapshot-entry.entity';
import { BackupCopy } from '../backups/entities/backup-copy.entity';

describe('StorageGarbageCollectorService', () => {
  it('marks unused objects first, then revalidates after grace before sweeping', async () => {
    const object = {
      id: 'orphan-object', userId: 'user-1', referenceCount: 0, lifecycleStatus: 'ACTIVE', gcAfter: null,
    } as StorageObject;
    const query = { setLock: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(object) };
    const objectRepository = {
      find: jest.fn().mockResolvedValue([object]),
      createQueryBuilder: jest.fn(() => query),
      save: jest.fn(async (value: StorageObject) => value),
      delete: jest.fn(),
    };
    const replicas = { find: jest.fn().mockResolvedValue([]) };
    const versions = { find: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), delete: jest.fn() };
    const snapshotEntries = { count: jest.fn().mockResolvedValue(0) };
    const backupCopies = { count: jest.fn().mockResolvedValue(0) };
    const nodes = { find: jest.fn().mockResolvedValue([]) };
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: unknown) => Promise<unknown>) => callback({
        getRepository: (entity: unknown) => entity === StorageObject ? objectRepository : entity === BackupCopy ? backupCopies : versions,
      })),
    };
    const queue = { enqueue: jest.fn() };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn((key: string) => key === 'dataProtection.storageGcGraceHours' ? 1 : undefined) };
    const service = new StorageGarbageCollectorService(
      objectRepository as never, replicas as never, versions as never, snapshotEntries as never, backupCopies as never, nodes as never,
      dataSource as never, queue as never, audit as never, config as never,
    );

    const marked = await service.collect();
    expect(marked).toMatchObject({ marked: 1, queuedForDeletion: 0 });
    expect(object.lifecycleStatus).toBe('GC_PENDING');
    expect(object.gcAfter).toBeInstanceOf(Date);
    expect(objectRepository.delete).not.toHaveBeenCalled();

    object.gcAfter = new Date(Date.now() - 60_000);
    const swept = await service.collect();
    expect(swept).toMatchObject({ marked: 0, queuedForDeletion: 1 });
    expect(object.lifecycleStatus).toBe('DELETING');
    expect(objectRepository.delete).toHaveBeenCalledWith(object.id);
  });
});
