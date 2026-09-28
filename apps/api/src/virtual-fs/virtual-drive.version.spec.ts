import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualDriveService } from './virtual-drive.service';
import { StorageObject } from './entities/storage-object.entity';
import { FileVersion } from './entities/file-version.entity';
import { StorageReplica } from './entities/storage-replica.entity';
import { StoragePolicy } from './entities/storage-policy.entity';
import { VirtualNode } from './entities/virtual-node.entity';
import { VirtualNodeStatus } from './enums/virtual-node-status.enum';
import { VirtualNodeType } from './enums/virtual-node-type.enum';
import { StorageObjectStatus } from './enums/storage-object-status.enum';
import { CloudProvider } from '../providers/common/cloud-provider.enum';

describe('VirtualDriveService file versions', () => {
  let directory: string;
  let encryptedStage: string | undefined;

  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'cloudfusion-version-test-')); });
  afterEach(async () => {
    if (encryptedStage) await rm(encryptedStage, { force: true });
    encryptedStage = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  it('uploads a new version on the existing node and preserves its prior version reference', async () => {
    const node = {
      id: 'file-node', userId: 'owner', parentId: 'root', name: 'thesis.pdf', type: VirtualNodeType.FILE,
      mimeType: 'application/pdf', size: '10', status: VirtualNodeStatus.AVAILABLE,
      storageObjectId: 'old-object', currentVersionId: 'version-2', deletedAt: null,
      previousParentId: null, isRoot: false, isFavorite: false, lastAccessedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    } as VirtualNode;
    const root = { ...node, id: 'root', parentId: null, name: 'Mi Drive', type: VirtualNodeType.FOLDER, storageObjectId: null } as VirtualNode;
    const nodes = {
      findOne: jest.fn().mockResolvedValueOnce(node).mockResolvedValueOnce(node).mockResolvedValueOnce(root),
      create: jest.fn((value: Partial<VirtualNode>) => value),
      save: jest.fn(async (value: VirtualNode) => value),
    };
    const lockedNodeQuery = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(node),
    };
    const objectQuery = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    const objectRepository = {
      createQueryBuilder: jest.fn(() => objectQuery),
      create: jest.fn((value: Partial<StorageObject>) => value),
      save: jest.fn(async (value: StorageObject) => value),
    };
    const versionRepository = {
      findOne: jest.fn().mockResolvedValue({ versionNumber: 2 }),
      create: jest.fn((value: Partial<FileVersion>) => value),
      save: jest.fn(async (value: FileVersion) => ({ ...value, id: 'version-3', createdAt: new Date('2026-09-28T12:00:00Z') })),
    };
    const nodeRepository = {
      createQueryBuilder: jest.fn(() => lockedNodeQuery),
      create: jest.fn((value: Partial<VirtualNode>) => value),
      save: nodes.save,
    };
    const replicas = {
      create: jest.fn((value: Partial<StorageReplica>) => value),
      save: jest.fn(async (value: StorageReplica[]) => value.map((replica, index) => ({ ...replica, id: `replica-${index}` }))),
    };
    const policies = { findOne: jest.fn().mockResolvedValue({ id: 'policy', replicationFactor: 1 }) };
    const accounts = { list: jest.fn().mockResolvedValue([{ id: 'account', provider: CloudProvider.GOOGLE_DRIVE, status: 'CONNECTED', storage: { used: 0, total: 1000 } }]) };
    const queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn((key: string) => key === 'virtualDrive.defaultReplicationFactor' ? 1 : undefined) };
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: unknown) => Promise<unknown>) => callback({
        query: jest.fn(),
        getRepository: (entity: unknown) => entity === StorageObject ? objectRepository : entity === FileVersion ? versionRepository : nodeRepository,
      })),
    };
    const encryption = {
      encryptFile: jest.fn(async (_input: string, output: string) => {
        encryptedStage = output;
        await writeFile(output, 'encrypted-v3');
        return {
          encryptionAlgorithm: 'AES-256-GCM' as const,
          encryptedDek: 'wrap-v3', dekIv: 'dek-iv-v3', dekAuthTag: 'dek-tag-v3', keyVersion: 1,
          contentIv: 'content-iv-v3', contentAuthTag: 'content-tag-v3', checksum: 'checksum-v3',
          encryptedChecksum: 'cipher-v3', logicalSize: 12, encryptedSize: 12,
        };
      }),
    };
    const service = new VirtualDriveService(
      nodes as never, objectRepository as never, replicas as never, policies as never,
      accounts as never, queue as never, audit as never, config as never, dataSource as never, encryption as never,
      versionRepository as never,
    );
    const inputPath = join(directory, 'v3.pdf');
    await writeFile(inputPath, 'new version!');

    const result = await service.uploadVersion('owner', 'file-node', {
      path: inputPath, originalname: 'replacement.pdf', mimetype: 'application/pdf', size: 12,
    } as Express.Multer.File, 'September revision');

    expect(result.version).toMatchObject({ id: 'version-3', versionNumber: 3, checksum: 'checksum-v3', size: 12 });
    expect(result.node).toMatchObject({ id: 'file-node', currentVersionId: 'version-3', storageObjectId: expect.any(String) });
    expect(versionRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      virtualNodeId: 'file-node', versionNumber: 3, comment: 'September revision', createdBy: 'owner',
    }));
    expect(nodes.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-node', currentVersionId: 'version-3' }));
    expect(audit.record).toHaveBeenCalledWith('owner', 'VIRTUAL_FILE_VERSION_CREATED', 'VirtualNode', 'file-node', expect.objectContaining({ versionNumber: 3 }));
    expect(result.node.status).toBe(VirtualNodeStatus.UPLOADING);
    expect(objectRepository.save).toHaveBeenCalledWith(expect.objectContaining({ status: StorageObjectStatus.UPLOADING }));
  });

  it('restores an old version by creating a new version instead of deleting the current one', async () => {
    const node = {
      id: 'file-node', userId: 'owner', parentId: 'root', name: 'thesis.pdf', type: VirtualNodeType.FILE,
      mimeType: 'application/pdf', size: '30', status: VirtualNodeStatus.AVAILABLE,
      storageObjectId: 'current-object', currentVersionId: 'version-3', deletedAt: null,
      previousParentId: null, isRoot: false, isFavorite: false, lastAccessedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    } as VirtualNode;
    const sourceVersion = { id: 'version-1', virtualNodeId: node.id, storageObjectId: 'old-object', versionNumber: 1, size: '10', checksum: 'checksum-v1' } as FileVersion;
    const oldObject = {
      id: 'old-object', userId: 'owner', referenceCount: 1, lifecycleStatus: 'ACTIVE',
      status: StorageObjectStatus.AVAILABLE, mimeType: 'application/pdf',
    } as StorageObject;
    const nodes = { findOne: jest.fn().mockResolvedValue(node), save: jest.fn(async (value: VirtualNode) => value) };
    const nodeQuery = { setLock: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(node) };
    const objectQuery = { setLock: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(oldObject) };
    const objectRepository = {
      createQueryBuilder: jest.fn(() => objectQuery),
      save: jest.fn(async (value: StorageObject) => value),
    };
    const versionRepository = {
      findOne: jest.fn().mockResolvedValueOnce(sourceVersion).mockResolvedValueOnce({ versionNumber: 3 }),
      create: jest.fn((value: Partial<FileVersion>) => value),
      save: jest.fn(async (value: FileVersion) => ({ ...value, id: 'version-4', createdAt: new Date() })),
    };
    const nodeRepository = {
      createQueryBuilder: jest.fn(() => nodeQuery),
      save: nodes.save,
    };
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: unknown) => Promise<unknown>) => callback({
        getRepository: (entity: unknown) => entity === VirtualNode ? nodeRepository : entity === StorageObject ? objectRepository : versionRepository,
      })),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new VirtualDriveService(
      nodes as never, objectRepository as never, {} as never, {} as never, {} as never,
      {} as never, audit as never, {} as never, dataSource as never, {} as never, versionRepository as never,
    );

    const result = await service.restoreVersion('owner', node.id, sourceVersion.id);

    expect(result).toMatchObject({ currentVersionId: 'version-4', storageObjectId: 'old-object', size: 10 });
    expect(versionRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      virtualNodeId: node.id, storageObjectId: 'old-object', versionNumber: 4, comment: 'Restored from version 1',
    }));
    expect(objectRepository.save).toHaveBeenCalledWith(expect.objectContaining({ referenceCount: 2 }));
    expect(audit.record).toHaveBeenCalledWith('owner', 'VIRTUAL_FILE_VERSION_RESTORED', 'VirtualNode', node.id, {
      sourceVersionId: 'version-1', versionNumber: 4,
    });
  });
});
