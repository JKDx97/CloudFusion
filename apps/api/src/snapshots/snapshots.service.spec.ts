import { SnapshotsService } from './snapshots.service';
import { Snapshot } from './entities/snapshot.entity';
import { SnapshotEntry } from './entities/snapshot-entry.entity';
import { SnapshotRestoreJob } from './entities/snapshot-restore-job.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { VirtualNodeStatus } from '../virtual-fs/enums/virtual-node-status.enum';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';
import { StorageObject } from '../virtual-fs/entities/storage-object.entity';

describe('SnapshotsService', () => {
  it('captures a logical tree and pins current file versions without copying content', async () => {
    const root = {
      id: 'root', userId: 'user-1', parentId: null, name: 'Mi Drive', type: VirtualNodeType.FOLDER,
      mimeType: 'inode/directory', size: null, status: VirtualNodeStatus.AVAILABLE,
      storageObjectId: null, currentVersionId: null, deletedAt: null, createdAt: new Date('2026-09-01'),
    } as VirtualNode;
    const file = {
      id: 'file-1', userId: 'user-1', parentId: 'root', name: 'tesis.pdf', type: VirtualNodeType.FILE,
      mimeType: 'application/pdf', size: '42', status: VirtualNodeStatus.AVAILABLE,
      storageObjectId: 'object-1', currentVersionId: 'version-5', deletedAt: null, createdAt: new Date('2026-09-02'),
    } as VirtualNode;
    const snapshotRow = { id: 'snapshot-1', userId: 'user-1', status: 'CREATING', nodeCount: 0, logicalSize: '0' } as Snapshot;
    const entryRows: SnapshotEntry[] = [];
    const snapshotsRepository = {
      create: jest.fn((value: Partial<Snapshot>) => value),
      save: jest.fn(async (value: Partial<Snapshot>) => Object.assign(snapshotRow, value, { id: snapshotRow.id, createdAt: snapshotRow.createdAt ?? new Date() })),
      find: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    const snapshotEntriesRepository = {
      create: jest.fn((value: Partial<SnapshotEntry>) => value),
      save: jest.fn(async (values: SnapshotEntry[]) => { entryRows.push(...values); return values; }),
    };
    const nodesRepository = { find: jest.fn().mockResolvedValue([root, file]) };
    const versionsRepository = { find: jest.fn().mockResolvedValue([{ id: 'version-5', virtualNodeId: 'file-1' }]) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const dataSource = {
      transaction: jest.fn(async (_isolation: string, callback: (manager: unknown) => Promise<unknown>) => callback({
        getRepository: (entity: unknown) => entity === VirtualNode
          ? nodesRepository
          : entity === FileVersion
            ? versionsRepository
            : entity === SnapshotEntry
              ? snapshotEntriesRepository
              : { findOne: jest.fn().mockResolvedValue(snapshotRow), save: jest.fn(async (value: Snapshot) => value) },
      })),
    };
    const restoreJobs = { findOne: jest.fn(), find: jest.fn(), create: jest.fn(), save: jest.fn() };
    const restoreQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new SnapshotsService(snapshotsRepository as never, snapshotEntriesRepository as never, nodesRepository as never, dataSource as never, audit as never, restoreJobs as never, restoreQueue as never);

    const snapshot = await service.create('user-1', { name: 'Pre cambios', isImmutable: true });

    expect(snapshot).toMatchObject({ id: 'snapshot-1', status: 'AVAILABLE', nodeCount: 2, logicalSize: '42', isImmutable: true });
    expect(entryRows).toHaveLength(2);
    const rootEntry = entryRows.find((entry) => entry.virtualNodeId === 'root');
    const fileEntry = entryRows.find((entry) => entry.virtualNodeId === 'file-1');
    expect(fileEntry).toMatchObject({ snapshotId: 'snapshot-1', parentSnapshotEntryId: rootEntry?.id, fileVersionId: 'version-5' });
    expect(snapshotEntriesRepository.save).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith('user-1', 'SNAPSHOT_CREATED', 'Snapshot', 'snapshot-1', expect.objectContaining({ nodeCount: 2 }));
  });

  it('restores a conflicting folder under a safe renamed path by default', async () => {
    const root = { id: 'drive-root', userId: 'user-1', type: VirtualNodeType.FOLDER, isRoot: true } as VirtualNode;
    const conflict = { id: 'existing-folder', name: 'Universidad', type: VirtualNodeType.FOLDER } as VirtualNode;
    const snapshot = { id: 'snapshot-1', userId: 'user-1', status: 'AVAILABLE', name: 'Previo' } as Snapshot;
    const entry = {
      id: 'entry-1', snapshotId: snapshot.id, virtualNodeId: null, parentSnapshotEntryId: null,
      fileVersionId: null, name: 'Universidad', type: 'FOLDER', isRoot: false, mimeType: 'inode/directory', size: null,
    } as SnapshotEntry;
    const snapshotsRepository = { findOne: jest.fn().mockResolvedValue(snapshot) };
    const entriesRepository = { findOne: jest.fn().mockResolvedValue(entry) };
    const nodesRepository = { findOne: jest.fn().mockResolvedValue(root) };
    const nodeRepository = {
      findOne: jest.fn().mockResolvedValueOnce(conflict).mockResolvedValueOnce(null),
      create: jest.fn((value: Partial<VirtualNode>) => value),
      save: jest.fn(async (value: VirtualNode) => ({ ...value, id: 'restored-folder' })),
    };
    const entriesTransactionRepository = { findOne: jest.fn() };
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: unknown) => Promise<unknown>) => callback({
        query: jest.fn(),
        getRepository: (entity: unknown) => entity === VirtualNode ? nodeRepository : entity === StorageObject ? {} : entity === FileVersion ? {} : entriesTransactionRepository,
      })),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const restoreJobs = { findOne: jest.fn(), find: jest.fn(), create: jest.fn(), save: jest.fn() };
    const restoreQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new SnapshotsService(snapshotsRepository as never, entriesRepository as never, nodesRepository as never, dataSource as never, audit as never, restoreJobs as never, restoreQueue as never);

    const result = await service.restoreEntry('user-1', 'snapshot-1', 'entry-1');

    expect(result).toMatchObject({ status: 'RESTORED', nodeId: 'restored-folder', name: 'Universidad (restored)' });
    expect(nodeRepository.create).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'drive-root', name: 'Universidad (restored)', type: VirtualNodeType.FOLDER }));
    expect(audit.record).toHaveBeenCalledWith('user-1', 'SNAPSHOT_ENTRY_RESTORED', 'SnapshotEntry', 'entry-1', expect.objectContaining({ strategy: 'RESTORE_RENAME' }));
  });

  it('queues full snapshot restoration as an idempotent background job', async () => {
    const snapshot = { id: 'snapshot-1', userId: 'user-1', status: 'AVAILABLE' } as Snapshot;
    const savedJob = { id: 'restore-job-1', userId: 'user-1', snapshotId: 'snapshot-1', status: 'QUEUED', totalEntries: 3 };
    const snapshotsRepository = { findOne: jest.fn().mockResolvedValue(snapshot) };
    const entriesRepository = { count: jest.fn().mockResolvedValue(3) };
    const jobsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: Partial<SnapshotRestoreJob>) => value),
      save: jest.fn(async (value: Partial<SnapshotRestoreJob>) => ({ ...value, id: savedJob.id })),
    };
    const queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new SnapshotsService(snapshotsRepository as never, entriesRepository as never, {} as never, {} as never, audit as never, jobsRepository as never, queue as never);

    const job = await service.queueSnapshotRestore('user-1', 'snapshot-1');

    expect(job).toMatchObject({ id: 'restore-job-1', status: 'QUEUED', totalEntries: 3 });
    expect(queue.enqueue).toHaveBeenCalledWith('restore-job-1');
    expect(audit.record).toHaveBeenCalledWith('user-1', 'SNAPSHOT_RESTORE_QUEUED', 'SnapshotRestoreJob', 'restore-job-1', { snapshotId: 'snapshot-1' });
  });

  it('processes a full restore in parent-first order and persists progress', async () => {
    const snapshot = { id: 'snapshot-1', userId: 'user-1', status: 'AVAILABLE', name: 'Previo' } as Snapshot;
    const rootEntry = { id: 'root-entry', isRoot: true, parentSnapshotEntryId: null } as SnapshotEntry;
    const folderEntry = { id: 'folder-entry', isRoot: false, parentSnapshotEntryId: 'root-entry' } as SnapshotEntry;
    const job = {
      id: 'restore-job-1', userId: 'user-1', snapshotId: 'snapshot-1', status: 'QUEUED',
      totalEntries: 2, processedEntries: 0, entryMappings: {}, errors: [], startedAt: null, completedAt: null,
    } as SnapshotRestoreJob;
    const snapshotsRepository = { findOne: jest.fn().mockResolvedValue(snapshot) };
    const entriesRepository = { find: jest.fn().mockResolvedValue([folderEntry, rootEntry]) };
    const nodesRepository = { findOne: jest.fn().mockResolvedValue({ id: 'drive-root', userId: 'user-1', isRoot: true }) };
    const jobsRepository = {
      findOne: jest.fn().mockResolvedValue(job),
      save: jest.fn(async (value: SnapshotRestoreJob) => value),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new SnapshotsService(
      snapshotsRepository as never, entriesRepository as never, nodesRepository as never, {} as never,
      audit as never, jobsRepository as never, {} as never,
    );
    const restoreEntry = jest.spyOn(service, 'restoreEntry').mockResolvedValue({ status: 'RESTORED', nodeId: 'restored-folder', name: 'Universidad' });

    await service.processRestoreJob(job.id);

    expect(restoreEntry).toHaveBeenCalledWith('user-1', 'snapshot-1', 'folder-entry', 'RESTORE_RENAME', 'drive-root', job.id);
    expect(job).toMatchObject({ status: 'COMPLETED', processedEntries: 1, entryMappings: { 'root-entry': 'drive-root', 'folder-entry': 'restored-folder' } });
    expect(audit.record).toHaveBeenCalledWith('user-1', 'SNAPSHOT_RESTORE_COMPLETED', 'SnapshotRestoreJob', job.id, expect.objectContaining({ errorCount: 0 }));
  });
});
