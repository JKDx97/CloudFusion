import { ConflictException, NotFoundException } from '@nestjs/common';
import { VirtualDriveService } from './virtual-drive.service';
import { VirtualNode } from './entities/virtual-node.entity';
import { StorageObject } from './entities/storage-object.entity';
import { VirtualNodeStatus } from './enums/virtual-node-status.enum';
import { VirtualNodeType } from './enums/virtual-node-type.enum';

function node(overrides: Partial<VirtualNode> = {}): VirtualNode {
  return {
    id: 'node-id',
    userId: 'owner-id',
    parentId: null,
    name: 'Mi Drive',
    type: VirtualNodeType.FOLDER,
    mimeType: 'inode/directory',
    size: null,
    status: VirtualNodeStatus.AVAILABLE,
    storageObjectId: null,
    deletedAt: null,
    previousParentId: null,
    isRoot: true,
    isFavorite: false,
    lastAccessedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function fixture() {
  const nodes = {
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    create: jest.fn((value: Partial<VirtualNode>) => value),
    save: jest.fn(async (value: VirtualNode) => ({ ...value, id: value.id ?? 'new-node', createdAt: value.createdAt ?? new Date(), updatedAt: new Date() })),
    delete: jest.fn(),
  };
  const objects = { findOne: jest.fn(), save: jest.fn(), create: jest.fn(), createQueryBuilder: jest.fn(), delete: jest.fn(), count: jest.fn() };
  const replicas = { findOne: jest.fn(), find: jest.fn(), save: jest.fn(), create: jest.fn(), count: jest.fn() };
  const policies = { findOne: jest.fn(), save: jest.fn(), create: jest.fn((value: unknown) => value) };
  const accounts = { list: jest.fn(), getOwnedAccount: jest.fn() };
  const queue = { enqueue: jest.fn() };
  const audit = { record: jest.fn() };
  const encryption = { encryptFile: jest.fn(), decryptFile: jest.fn() };
  const dataSource = { transaction: jest.fn() };
  const config = { get: jest.fn((key: string) => key === 'virtualDrive.defaultReplicationFactor' ? 1 : undefined) };
  const service = new VirtualDriveService(nodes as never, objects as never, replicas as never, policies as never, accounts as never, queue as never, audit as never, config as never, dataSource as never, encryption as never);
  return { service, nodes, objects, replicas, policies, accounts, queue, audit, encryption, dataSource };
}

describe('VirtualDriveService', () => {
  it('creates a per-user root on first access', async () => {
    const fixtureData = fixture();
    fixtureData.nodes.findOne.mockResolvedValue(null);
    fixtureData.nodes.save.mockResolvedValue(node());

    const result = await fixtureData.service.getRoot('owner-id');

    expect(result.isRoot).toBe(true);
    expect(fixtureData.nodes.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-id', isRoot: true, parentId: null }));
  });

  it('rejects access to another user node', async () => {
    const fixtureData = fixture();
    fixtureData.nodes.findOne.mockResolvedValue(null);

    await expect(fixtureData.service.getNode('other-user', 'node-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates a virtual folder under the user root', async () => {
    const fixtureData = fixture();
    fixtureData.nodes.findOne.mockResolvedValueOnce(node()).mockResolvedValueOnce(null);
    fixtureData.nodes.save.mockResolvedValue(node({ id: 'folder-id', name: 'Trabajo', isRoot: false, parentId: 'node-id' }));

    const result = await fixtureData.service.createFolder('owner-id', { name: 'Trabajo' });

    expect(result.name).toBe('Trabajo');
    expect(fixtureData.audit.record).toHaveBeenCalledWith('owner-id', 'VIRTUAL_FOLDER_CREATED', 'VirtualNode', 'folder-id', { parentId: 'node-id' });
  });

  it('rejects duplicate names within one virtual parent', async () => {
    const fixtureData = fixture();
    fixtureData.nodes.findOne.mockResolvedValueOnce(node()).mockResolvedValueOnce(node({ id: 'existing', name: 'Trabajo', isRoot: false }));

    await expect(fixtureData.service.createFolder('owner-id', { name: 'Trabajo' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('moves a node by changing only its parent metadata', async () => {
    const source = node({ id: 'file-id', name: 'notes.txt', type: VirtualNodeType.FILE, isRoot: false, parentId: 'root-id' });
    const target = node({ id: 'target-id', name: 'Archive', isRoot: false });
    const fixtureData = fixture();
    fixtureData.nodes.findOne.mockResolvedValueOnce(source).mockResolvedValueOnce(target).mockResolvedValueOnce(target).mockResolvedValueOnce(null);
    fixtureData.nodes.save.mockResolvedValue({ ...source, parentId: 'target-id' });

    const result = await fixtureData.service.move('owner-id', 'file-id', { parentId: 'target-id' });

    expect(result.parentId).toBe('target-id');
    expect(fixtureData.audit.record).toHaveBeenCalledWith('owner-id', 'VIRTUAL_NODE_MOVED', 'VirtualNode', 'file-id', { previousParentId: 'root-id', parentId: 'target-id' });
  });

  it('trashes and restores a virtual node without deleting metadata', async () => {
    const file = node({ id: 'file-id', name: 'notes.txt', type: VirtualNodeType.FILE, isRoot: false, parentId: 'root-id' });
    const root = node({ id: 'root-id' });
    const fixtureData = fixture();
    fixtureData.nodes.findOne.mockResolvedValueOnce(file).mockResolvedValueOnce(file).mockResolvedValueOnce(root).mockResolvedValueOnce(null);
    fixtureData.nodes.find.mockResolvedValue([]);
    fixtureData.nodes.save.mockImplementation(async (value: VirtualNode) => value);

    await expect(fixtureData.service.trash('owner-id', 'file-id')).resolves.toEqual({ deleted: true });
    file.deletedAt = new Date();
    file.previousParentId = 'root-id';
    await expect(fixtureData.service.restore('owner-id', 'file-id')).resolves.toEqual(expect.objectContaining({ id: 'file-id', deletedAt: null }));
    expect(fixtureData.nodes.delete).not.toHaveBeenCalled();
  });

  it('keeps a shared storage object and its replicas when permanently deleting only one reference', async () => {
    const trashedFile = node({
      id: 'duplicate-node', name: 'copy.pdf', type: VirtualNodeType.FILE, isRoot: false,
      parentId: 'root-id', storageObjectId: 'shared-object', deletedAt: new Date(),
    });
    const storageObject = { id: 'shared-object', userId: 'owner-id', referenceCount: 2, lifecycleStatus: 'ACTIVE' };
    const lockQuery = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(storageObject),
    };
    const fixtureData = fixture();
    fixtureData.nodes.findOne.mockResolvedValue(trashedFile);
    fixtureData.nodes.find.mockResolvedValue([]);
    fixtureData.nodes.count.mockResolvedValue(1);
    fixtureData.objects.createQueryBuilder.mockReturnValue(lockQuery);
    fixtureData.objects.findOne.mockResolvedValue(storageObject);
    fixtureData.objects.save.mockImplementation(async (value) => value);
    fixtureData.dataSource.transaction.mockImplementation(async (callback: (manager: unknown) => Promise<unknown>) => callback({
      query: jest.fn(),
      getRepository: (entity: unknown) => entity === StorageObject ? fixtureData.objects : fixtureData.nodes,
    }));

    await expect(fixtureData.service.permanentDelete('owner-id', 'duplicate-node')).resolves.toEqual({ deleted: true });

    expect(fixtureData.nodes.delete).toHaveBeenCalledWith(['duplicate-node']);
    expect(fixtureData.objects.save).toHaveBeenCalledWith(expect.objectContaining({ referenceCount: 1, lifecycleStatus: 'ACTIVE' }));
    expect(fixtureData.objects.delete).not.toHaveBeenCalled();
    expect(fixtureData.replicas.find).not.toHaveBeenCalled();
    expect(fixtureData.queue.enqueue).not.toHaveBeenCalled();
  });
});
