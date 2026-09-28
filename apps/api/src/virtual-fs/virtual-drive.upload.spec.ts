import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualDriveService } from './virtual-drive.service';
import { VirtualNode } from './entities/virtual-node.entity';
import { StorageObject } from './entities/storage-object.entity';
import { StorageReplica } from './entities/storage-replica.entity';
import { StoragePolicy } from './entities/storage-policy.entity';
import { VirtualNodeStatus } from './enums/virtual-node-status.enum';
import { VirtualNodeType } from './enums/virtual-node-type.enum';
import { CloudProvider } from '../providers/common/cloud-provider.enum';

describe('VirtualDriveService protected upload', () => {
  let directory: string;
  let stagingFile: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cloudfusion-upload-test-'));
  });

  afterEach(async () => {
    if (stagingFile) await rm(stagingFile, { force: true });
    stagingFile = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  it('encrypts staging content before creating and queuing provider replicas', async () => {
    const root = {
      id: 'root-id', userId: 'owner', parentId: null, name: 'Mi Drive', type: VirtualNodeType.FOLDER,
      mimeType: 'inode/directory', size: null, status: VirtualNodeStatus.AVAILABLE, storageObjectId: null,
      deletedAt: null, previousParentId: null, isRoot: true, isFavorite: false, lastAccessedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    } as VirtualNode;
    const nodes = {
      findOne: jest.fn().mockResolvedValueOnce(root).mockResolvedValueOnce(null),
      create: jest.fn((value: Partial<VirtualNode>) => value),
      save: jest.fn(async (value: VirtualNode) => ({ ...value, id: value.id ?? 'virtual-file-id', createdAt: new Date(), updatedAt: new Date() })),
    };
    const objects = {
      create: jest.fn((value: Partial<StorageObject>) => value),
      save: jest.fn(async (value: StorageObject) => value),
    };
    const replicas = {
      create: jest.fn((value: Partial<StorageReplica>) => value),
      save: jest.fn(async (value: StorageReplica | StorageReplica[]) => Array.isArray(value) ? value.map((item, index) => ({ ...item, id: `replica-${index}` })) : value),
    };
    const policies = {
      findOne: jest.fn().mockResolvedValue({ id: 'policy-id', replicationFactor: 1 }),
    };
    const accounts = {
      list: jest.fn().mockResolvedValue([{
        id: 'account-id', provider: CloudProvider.GOOGLE_DRIVE, status: 'CONNECTED',
        storage: { used: 0, total: 10_000 },
      }]),
    };
    const queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn((key: string) => key === 'virtualDrive.defaultReplicationFactor' ? 1 : undefined) };
    const encryptedPayload = Buffer.from('ciphertext only');
    const encryption = {
      encryptFile: jest.fn(async (_input: string, output: string) => {
        await writeFile(output, encryptedPayload);
        return {
          encryptionAlgorithm: 'AES-256-GCM' as const,
          encryptedDek: 'wrapped-key', dekIv: 'dek-iv', dekAuthTag: 'dek-tag', keyVersion: 1,
          contentIv: 'content-iv', contentAuthTag: 'content-tag', checksum: 'plain-checksum',
          encryptedChecksum: 'cipher-checksum', logicalSize: 13, encryptedSize: encryptedPayload.length,
        };
      }),
    };
    const service = new VirtualDriveService(
      nodes as never, objects as never, replicas as never, policies as never,
      accounts as never, queue as never, audit as never, config as never, encryption as never,
    );
    const plaintextPath = join(directory, 'plain.pdf');
    await writeFile(plaintextPath, 'clear content');

    const result = await service.upload('owner', {
      path: plaintextPath, originalname: 'thesis.pdf', mimetype: 'application/pdf', size: 13,
    } as Express.Multer.File);

    expect(result.queued).toBe(true);
    expect(result.replicas).toBe(1);
    stagingFile = queue.enqueue.mock.calls[0][0].stagingPath;
    expect(encryption.encryptFile).toHaveBeenCalledWith(plaintextPath, expect.stringMatching(/\.cfdata$/), expect.any(String));
    expect(await readFile(stagingFile)).toEqual(encryptedPayload);
    expect(objects.save).toHaveBeenCalledWith(expect.objectContaining({
      checksum: 'plain-checksum', encryptedChecksum: 'cipher-checksum',
      encryptedDek: 'wrapped-key', encryptionAlgorithm: 'AES-256-GCM',
    }));
    await expect(readFile(plaintextPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
