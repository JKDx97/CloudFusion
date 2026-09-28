import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { CloudAccountService, CloudAccountPublic } from '../cloud-accounts/cloud-account.service';
import { StorageObject } from './entities/storage-object.entity';
import { FileVersion } from './entities/file-version.entity';
import { StoragePolicy } from './entities/storage-policy.entity';
import { StorageReplica } from './entities/storage-replica.entity';
import { VirtualNode } from './entities/virtual-node.entity';
import { StorageObjectStatus } from './enums/storage-object-status.enum';
import { StoragePolicyType } from './enums/storage-policy-type.enum';
import { StorageReplicaStatus } from './enums/storage-replica-status.enum';
import { VirtualNodeStatus } from './enums/virtual-node-status.enum';
import { VirtualNodeType } from './enums/virtual-node-type.enum';
import { CreateVirtualFolderDto } from './dto/create-virtual-folder.dto';
import { MoveVirtualNodeDto } from './dto/move-virtual-node.dto';
import { UpdateVirtualNodeDto } from './dto/update-virtual-node.dto';
import { ReplicationQueueService } from './replication-queue.service';
import { CloudDownload } from '../providers/common/cloud-file.interface';
import { EncryptionService, DecryptionMetadata } from '../data-protection/encryption.service';
import { DataProtectionException } from '../data-protection/data-protection-error';

export interface VirtualNodeResponse {
  id: string;
  userId: string;
  parentId: string | null;
  name: string;
  type: VirtualNodeType;
  mimeType: string | null;
  size: number | null;
  status: VirtualNodeStatus;
  storageObjectId: string | null;
  currentVersionId: string | null;
  isRoot: boolean;
  isFavorite: boolean;
  deletedAt: Date | null;
  lastAccessedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VirtualUploadResult {
  node: VirtualNodeResponse;
  queued: boolean;
  replicas: number;
  deduplicated?: boolean;
  version?: { id: string; versionNumber: number; checksum: string; size: number; createdAt: Date };
  warning?: string;
}

@Injectable()
export class VirtualDriveService {
  constructor(
    @InjectRepository(VirtualNode)
    private readonly nodes: Repository<VirtualNode>,
    @InjectRepository(StorageObject)
    private readonly objects: Repository<StorageObject>,
    @InjectRepository(StorageReplica)
    private readonly replicas: Repository<StorageReplica>,
    @InjectRepository(StoragePolicy)
    private readonly policies: Repository<StoragePolicy>,
    private readonly accounts: CloudAccountService,
    private readonly queue: ReplicationQueueService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    @InjectRepository(FileVersion) private readonly fileVersions: Repository<FileVersion>,
  ) {}

  async getRoot(userId: string): Promise<VirtualNodeResponse> {
    return this.toResponse(await this.ensureRoot(userId));
  }

  async getNode(userId: string, id: string): Promise<VirtualNodeResponse> {
    const node = await this.findOwned(id, userId);
    node.lastAccessedAt = new Date();
    return this.toResponse(await this.nodes.save(node));
  }

  async download(userId: string, id: string): Promise<CloudDownload> {
    const node = await this.findOwned(id, userId);
    if (node.type !== VirtualNodeType.FILE || !node.storageObjectId) throw new BadRequestException('Only virtual files can be downloaded');
    return this.downloadStorageObject(userId, node, node.storageObjectId);
  }

  async downloadVersion(userId: string, id: string, versionId: string): Promise<CloudDownload> {
    const node = await this.findOwned(id, userId);
    if (node.type !== VirtualNodeType.FILE) throw new BadRequestException('Only virtual files can be downloaded');
    const version = await this.fileVersions.findOne({ where: { id: versionId, virtualNodeId: node.id } });
    if (!version) throw new NotFoundException('File version not found');
    return this.downloadStorageObject(userId, node, version.storageObjectId);
  }

  private async downloadStorageObject(userId: string, node: VirtualNode, storageObjectId: string): Promise<CloudDownload> {
    const object = await this.objects.createQueryBuilder('storageObject')
      .addSelect([
        'storageObject.encryptedDek',
        'storageObject.dekIv',
        'storageObject.dekAuthTag',
        'storageObject.contentIv',
        'storageObject.contentAuthTag',
      ])
      .where('storageObject.id = :id AND storageObject.userId = :userId', { id: storageObjectId, userId })
      .getOne();
    if (!object) throw new NotFoundException('Storage object not found');
    const replicas = await this.replicas.find({ where: { storageObjectId: object.id }, order: { status: 'ASC', lastVerifiedAt: 'DESC' } });
    let failures = 0;
    let protectionError: DataProtectionException | null = null;
    for (const replica of replicas.sort((a, b) => Number(b.status === StorageReplicaStatus.HEALTHY) - Number(a.status === StorageReplicaStatus.HEALTHY))) {
      if (!replica.remoteFileId || replica.status === StorageReplicaStatus.MISSING || replica.status === StorageReplicaStatus.CORRUPTED) continue;
      try {
        const context = await this.accounts.getAuthorizedAccount(userId, replica.cloudAccountId);
        const remote = await context.adapter.getFile(context.accessToken, context.account.id, replica.remoteFileId);
        if (remote.type !== 'file') throw new Error('Remote replica is not a file');
        const download = await context.adapter.downloadFile(context.accessToken, context.account.id, replica.remoteFileId);
        node.lastAccessedAt = new Date();
        await this.nodes.save(node);
        if (failures > 0) await this.audit.record(userId, 'REPLICA_FAILOVER', 'StorageObject', object.id, { selectedReplicaId: replica.id, failures });
        if (object.encryptionAlgorithm) {
          if (!object.encryptedDek || !object.dekIv || !object.dekAuthTag || !object.contentIv || !object.contentAuthTag || object.keyVersion == null || !object.encryptedChecksum || object.encryptedSize == null) {
            throw new DataProtectionException('CORRUPTED_ENCRYPTED_OBJECT');
          }
          const outputPath = join(tmpdir(), 'cloudfusion-downloads', `${randomUUID()}.restored`);
          await mkdir(dirname(outputPath), { recursive: true });
          try {
            await this.encryption.decryptFile(download.stream, outputPath, object.id, {
              encryptedDek: object.encryptedDek,
              dekIv: object.dekIv,
              dekAuthTag: object.dekAuthTag,
              keyVersion: object.keyVersion,
              encryptionAlgorithm: object.encryptionAlgorithm as 'AES-256-GCM',
              contentIv: object.contentIv,
              contentAuthTag: object.contentAuthTag,
              checksum: object.checksum,
              encryptedChecksum: object.encryptedChecksum,
              logicalSize: Number(object.size),
              encryptedSize: Number(object.encryptedSize),
            } satisfies DecryptionMetadata);
            const plaintext = createReadStream(outputPath);
            plaintext.once('close', () => void unlink(outputPath).catch(() => undefined));
            return { stream: plaintext, fileName: node.name, mimeType: object.mimeType ?? download.mimeType, size: Number(object.size) };
          } catch (error) {
            await unlink(outputPath).catch(() => undefined);
            throw error;
          }
        }
        return download;
      } catch (error) {
        if (error instanceof DataProtectionException && ['KEY_UNAVAILABLE', 'KEY_VERSION_UNKNOWN'].includes(error.code)) throw error;
        failures += 1;
        const integrityFailure = error instanceof DataProtectionException && [
          'DECRYPTION_FAILED',
          'INTEGRITY_CHECK_FAILED',
          'CORRUPTED_ENCRYPTED_OBJECT',
        ].includes(error.code);
        if (error instanceof DataProtectionException) protectionError = error;
        replica.status = integrityFailure ? StorageReplicaStatus.CORRUPTED : StorageReplicaStatus.DEGRADED;
        replica.lastError = error instanceof DataProtectionException ? error.code : 'Replica download failed';
        await this.replicas.save(replica);
      }
    }
    if (protectionError) throw protectionError;
    throw new ServiceUnavailableException('No healthy replica is available for this file');
  }

  async getChildren(userId: string, parentId?: string): Promise<VirtualNodeResponse[]> {
    const parent = parentId ? await this.findOwned(parentId, userId) : await this.ensureRoot(userId);
    if (parent.type !== VirtualNodeType.FOLDER) throw new BadRequestException('Parent node must be a folder');
    const children = await this.nodes.find({
      where: { userId, parentId: parent.id, deletedAt: IsNull() },
      order: { type: 'ASC', name: 'ASC' },
    });
    return children.map((node) => this.toResponse(node));
  }

  async createFolder(userId: string, dto: CreateVirtualFolderDto): Promise<VirtualNodeResponse> {
    const parent = dto.parentId ? await this.findOwned(dto.parentId, userId) : await this.ensureRoot(userId);
    if (parent.type !== VirtualNodeType.FOLDER) throw new BadRequestException('Parent node must be a folder');
    const name = this.cleanName(dto.name);
    await this.ensureAvailableName(userId, parent.id, name);
    const folder = await this.nodes.save(this.nodes.create({
      userId,
      parentId: parent.id,
      name,
      type: VirtualNodeType.FOLDER,
      mimeType: 'inode/directory',
      size: null,
      status: VirtualNodeStatus.AVAILABLE,
      storageObjectId: null,
      deletedAt: null,
      previousParentId: null,
      isRoot: false,
      isFavorite: false,
      lastAccessedAt: null,
    }));
    await this.audit.record(userId, 'VIRTUAL_FOLDER_CREATED', 'VirtualNode', folder.id, { parentId: parent.id });
    return this.toResponse(folder);
  }

  async upload(userId: string, file: Express.Multer.File, parentId?: string): Promise<VirtualUploadResult> {
    return this.uploadContent(userId, file, parentId);
  }

  async uploadVersion(userId: string, id: string, file: Express.Multer.File, comment?: string): Promise<VirtualUploadResult> {
    const node = await this.findOwned(id, userId);
    if (node.type !== VirtualNodeType.FILE) throw new BadRequestException('Only files can have new versions');
    const normalizedComment = comment?.trim() || undefined;
    if (normalizedComment && normalizedComment.length > 500) throw new BadRequestException('Version comments must be 500 characters or fewer');
    return this.uploadContent(userId, file, node.parentId ?? undefined, node.id, normalizedComment);
  }

  private async uploadContent(
    userId: string,
    file: Express.Multer.File,
    parentId?: string,
    versionNodeId?: string,
    versionComment?: string,
  ): Promise<VirtualUploadResult> {
    if (!file) throw new BadRequestException('A file is required');
    const targetNode = versionNodeId ? await this.findOwned(versionNodeId, userId) : null;
    if (targetNode && targetNode.type !== VirtualNodeType.FILE) throw new BadRequestException('Only files can have new versions');
    const parent = targetNode
      ? targetNode.parentId ? await this.findOwned(targetNode.parentId, userId) : await this.ensureRoot(userId)
      : parentId ? await this.findOwned(parentId, userId) : await this.ensureRoot(userId);
    if (parent.type !== VirtualNodeType.FOLDER) throw new BadRequestException('Parent node must be a folder');
    const name = targetNode ? targetNode.name : this.cleanName(file.originalname);
    if (!targetNode) await this.ensureAvailableName(userId, parent.id, name);
    const policy = await this.ensureDefaultPolicy(userId);
    const storageObjectId = randomUUID();
    const encryptedDirectory = join(tmpdir(), 'cloudfusion-encrypted-uploads');
    const encryptedPath = join(encryptedDirectory, `${storageObjectId}.cfdata`);
    await mkdir(encryptedDirectory, { recursive: true });
    let encrypted: Awaited<ReturnType<EncryptionService['encryptFile']>>;
    try {
      encrypted = await this.encryption.encryptFile(file.path, encryptedPath, storageObjectId);
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
    if (encrypted.logicalSize !== file.size) {
      await unlink(encryptedPath).catch(() => undefined);
      throw new BadRequestException('Uploaded file size changed during encryption');
    }
    let handedToWorker = false;
    try {
      const created = await this.dataSource.transaction(async (manager) => {
        const objectRepository = manager.getRepository(StorageObject);
        const nodeRepository = manager.getRepository(VirtualNode);
        const versionRepository = manager.getRepository(FileVersion);
        const versionTarget = versionNodeId
          ? await nodeRepository.createQueryBuilder('virtualNode')
            .setLock('pessimistic_write')
            .where('virtualNode.id = :id AND virtualNode.userId = :userId AND virtualNode.deletedAt IS NULL', { id: versionNodeId, userId })
            .getOne()
          : null;
        if (versionNodeId && (!versionTarget || versionTarget.type !== VirtualNodeType.FILE)) throw new NotFoundException('Virtual file not found');
        const lockKey = `${userId}:${encrypted.checksum}:${encrypted.logicalSize}`;
        await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
        const nextVersionNumber = async (nodeId: string | undefined): Promise<number> => {
          if (!nodeId) return 1;
          const latest = await versionRepository.findOne({ where: { virtualNodeId: nodeId }, order: { versionNumber: 'DESC' } });
          return (latest?.versionNumber ?? 0) + 1;
        };
        const existing = await objectRepository.createQueryBuilder('storageObject')
          .setLock('pessimistic_write')
          .where('storageObject.userId = :userId', { userId })
          .andWhere('storageObject.checksum = :checksum', { checksum: encrypted.checksum })
          .andWhere('storageObject.size = :size', { size: String(encrypted.logicalSize) })
          .andWhere('storageObject.encryptionAlgorithm IS NOT NULL')
          .andWhere('storageObject.lifecycleStatus = :lifecycleStatus', { lifecycleStatus: 'ACTIVE' })
          .getOne();
        if (existing) {
          existing.referenceCount += 1;
          const sharedObject = await objectRepository.save(existing);
          const sharedNode = versionTarget ?? await nodeRepository.save(nodeRepository.create({
              userId,
              parentId: parent.id,
              name,
              type: VirtualNodeType.FILE,
              mimeType: file.mimetype || null,
              size: String(file.size),
              status: sharedObject.status as unknown as VirtualNodeStatus,
              storageObjectId: sharedObject.id,
              deletedAt: null,
              previousParentId: null,
              isRoot: false,
              isFavorite: false,
              lastAccessedAt: null,
            }));
          sharedNode.storageObjectId = sharedObject.id;
          sharedNode.size = String(encrypted.logicalSize);
          sharedNode.mimeType = file.mimetype || null;
          sharedNode.status = sharedObject.status as unknown as VirtualNodeStatus;
          const version = await versionRepository.save(versionRepository.create({
            virtualNodeId: sharedNode.id,
            storageObjectId: sharedObject.id,
            versionNumber: await nextVersionNumber(versionTarget?.id),
            size: String(encrypted.logicalSize),
            checksum: encrypted.checksum,
            createdBy: userId,
            comment: versionComment ?? null,
          }));
          sharedNode.currentVersionId = version.id;
          const savedNode = await nodeRepository.save(sharedNode);
          return { storageObject: sharedObject, node: savedNode, version, deduplicated: true };
        }

        const storageObject = await objectRepository.save(objectRepository.create({
          id: storageObjectId,
          userId,
          storageKey: `objects/${storageObjectId}`,
          size: String(encrypted.logicalSize),
          encryptedSize: String(encrypted.encryptedSize),
          mimeType: file.mimetype || null,
          checksum: encrypted.checksum,
          encryptedChecksum: encrypted.encryptedChecksum,
          checksumAlgorithm: 'SHA-256',
          encryptionAlgorithm: encrypted.encryptionAlgorithm,
          encryptedDek: encrypted.encryptedDek,
          dekIv: encrypted.dekIv,
          dekAuthTag: encrypted.dekAuthTag,
          contentIv: encrypted.contentIv,
          contentAuthTag: encrypted.contentAuthTag,
          keyVersion: encrypted.keyVersion,
          referenceCount: 1,
          lifecycleStatus: 'ACTIVE',
          gcAfter: null,
          status: StorageObjectStatus.UPLOADING,
          policyId: policy.id,
        }));
        const node = versionTarget ?? await nodeRepository.save(nodeRepository.create({
            userId,
            parentId: parent.id,
            name,
            type: VirtualNodeType.FILE,
            mimeType: file.mimetype || null,
            size: String(file.size),
            status: VirtualNodeStatus.UPLOADING,
            storageObjectId: storageObject.id,
            deletedAt: null,
            previousParentId: null,
            isRoot: false,
            isFavorite: false,
            lastAccessedAt: null,
          }));
        node.storageObjectId = storageObject.id;
        node.size = String(encrypted.logicalSize);
        node.mimeType = file.mimetype || null;
        node.status = VirtualNodeStatus.UPLOADING;
        const version = await versionRepository.save(versionRepository.create({
          virtualNodeId: node.id,
          storageObjectId: storageObject.id,
          versionNumber: await nextVersionNumber(versionTarget?.id),
          size: String(encrypted.logicalSize),
          checksum: encrypted.checksum,
          createdBy: userId,
          comment: versionComment ?? null,
        }));
        node.currentVersionId = version.id;
        const savedNode = await nodeRepository.save(node);
        return { storageObject, node: savedNode, version, deduplicated: false };
      });

      const { storageObject, node, version } = created;
      const versionInfo = { id: version.id, versionNumber: version.versionNumber, checksum: version.checksum, size: Number(version.size), createdAt: version.createdAt };
      if (created.deduplicated) {
        const replicaCount = await this.replicas.count({ where: { storageObjectId: storageObject.id } });
        await this.audit.record(userId, versionNodeId ? 'VIRTUAL_FILE_VERSION_CREATED' : 'VIRTUAL_UPLOAD_DEDUPLICATED', 'VirtualNode', node.id, { storageObjectId: storageObject.id, versionNumber: version.versionNumber });
        return { node: this.toResponse(node), queued: false, replicas: replicaCount, deduplicated: true, version: versionInfo };
      }

      const destinations = this.selectDestinations(await this.accounts.list(userId), policy.replicationFactor, file.size);
      if (destinations.length === 0) {
        storageObject.status = StorageObjectStatus.UNAVAILABLE;
        node.status = VirtualNodeStatus.UNAVAILABLE;
        await this.objects.save(storageObject);
        await this.nodes.save(node);
        await this.audit.record(userId, 'VIRTUAL_UPLOAD_UNAVAILABLE', 'VirtualNode', node.id, { reason: 'NO_CONNECTED_STORAGE_ACCOUNT' });
        return { node: this.toResponse(node), queued: false, replicas: 0, version: versionInfo, warning: 'Conecta al menos una cuenta cloud para guardar físicamente el archivo.' };
      }
      const replicaEntities = await this.replicas.save(destinations.map((account) => this.replicas.create({
        storageObjectId: storageObject.id,
        cloudAccountId: account.id,
        provider: account.provider,
        remoteFileId: null,
        remoteParentId: null,
        status: StorageReplicaStatus.PENDING,
        size: String(encrypted.encryptedSize),
        checksum: encrypted.encryptedChecksum,
        lastVerifiedAt: null,
        lastError: null,
        attempts: 0,
      })));
      let queued = true;
      for (const replica of replicaEntities) {
        try {
          await this.queue.enqueue({ replicaId: replica.id, stagingPath: encryptedPath });
          handedToWorker = true;
        } catch (error) {
          queued = false;
          replica.status = StorageReplicaStatus.FAILED;
          replica.lastError = error instanceof Error ? error.message : 'Replication queue unavailable';
          await this.replicas.save(replica);
        }
      }
      if (!queued) {
        node.status = VirtualNodeStatus.DEGRADED;
        storageObject.status = StorageObjectStatus.DEGRADED;
        await this.nodes.save(node);
        await this.objects.save(storageObject);
      }
      await this.audit.record(userId, versionNodeId ? 'VIRTUAL_FILE_VERSION_CREATED' : 'VIRTUAL_UPLOAD_QUEUED', 'VirtualNode', node.id, { replicationFactor: replicaEntities.length, versionNumber: version.versionNumber });
      return { node: this.toResponse(node), queued, replicas: replicaEntities.length, version: versionInfo };
    } finally {
      if (!handedToWorker) await unlink(encryptedPath).catch(() => undefined);
    }
  }

  async rename(userId: string, id: string, dto: UpdateVirtualNodeDto): Promise<VirtualNodeResponse> {
    const node = await this.findOwned(id, userId);
    if (node.isRoot) throw new BadRequestException('The drive root cannot be renamed');
    const name = this.cleanName(dto.name);
    await this.ensureAvailableName(userId, node.parentId, name, node.id);
    node.name = name;
    const saved = await this.nodes.save(node);
    await this.audit.record(userId, 'VIRTUAL_NODE_RENAMED', 'VirtualNode', id, { name });
    return this.toResponse(saved);
  }

  async move(userId: string, id: string, dto: MoveVirtualNodeDto): Promise<VirtualNodeResponse> {
    const node = await this.findOwned(id, userId);
    if (node.isRoot) throw new BadRequestException('The drive root cannot be moved');
    const parent = dto.parentId ? await this.findOwned(dto.parentId, userId) : await this.ensureRoot(userId);
    if (parent.type !== VirtualNodeType.FOLDER) throw new BadRequestException('Destination must be a folder');
    if (parent.id === node.id || await this.isDescendant(parent.id, node.id, userId)) throw new BadRequestException('Cannot move a folder inside itself');
    await this.ensureAvailableName(userId, parent.id, node.name, node.id);
    const previousParentId = node.parentId;
    node.parentId = parent.id;
    const saved = await this.nodes.save(node);
    await this.audit.record(userId, 'VIRTUAL_NODE_MOVED', 'VirtualNode', id, { previousParentId, parentId: parent.id });
    return this.toResponse(saved);
  }

  async trash(userId: string, id: string): Promise<{ deleted: true }> {
    const node = await this.findOwned(id, userId);
    if (node.isRoot) throw new BadRequestException('The drive root cannot be deleted');
    const descendants = await this.collectTree(userId, node);
    const now = new Date();
    for (const item of [node, ...descendants]) {
      item.previousParentId = item.parentId;
      item.deletedAt = now;
      item.status = VirtualNodeStatus.DELETING;
      await this.nodes.save(item);
    }
    await this.audit.record(userId, 'VIRTUAL_NODE_TRASHED', 'VirtualNode', id, { descendants: descendants.length });
    return { deleted: true };
  }

  async restore(userId: string, id: string): Promise<VirtualNodeResponse> {
    const node = await this.findOwned(id, userId, true);
    if (!node.deletedAt) throw new BadRequestException('Node is not in trash');
    const parent = node.previousParentId ? await this.findOwned(node.previousParentId, userId).catch(() => this.ensureRoot(userId)) : await this.ensureRoot(userId);
    await this.ensureAvailableName(userId, parent.id, node.name, node.id);
    const descendants = await this.collectTree(userId, node, true);
    for (const item of [node, ...descendants]) {
      item.deletedAt = null;
      item.status = VirtualNodeStatus.AVAILABLE;
      item.parentId = item.id === node.id ? parent.id : item.previousParentId;
      item.previousParentId = null;
      await this.nodes.save(item);
    }
    await this.audit.record(userId, 'VIRTUAL_NODE_RESTORED', 'VirtualNode', id, { parentId: parent.id });
    return this.toResponse(node);
  }

  async permanentDelete(userId: string, id: string): Promise<{ deleted: true }> {
    const node = await this.findOwned(id, userId, true);
    if (!node.deletedAt) throw new BadRequestException('Only trashed nodes can be permanently deleted');
    const descendants = await this.collectTree(userId, node, true);
    const all = [node, ...descendants];
    const objectIds = [...new Set(all.map((item) => item.storageObjectId).filter((value): value is string => Boolean(value)))];
    const unusedObjectIds = await this.dataSource.transaction(async (manager) => {
      const objectRepository = manager.getRepository(StorageObject);
      const nodeRepository = manager.getRepository(VirtualNode);
      const versionRepository = manager.getRepository(FileVersion);
      await manager.query(
        'SELECT "id" FROM "virtual_nodes" WHERE "id" = ANY($1::uuid[]) ORDER BY "id" FOR UPDATE',
        [all.map((item) => item.id)],
      );
      for (const objectId of objectIds) {
        await objectRepository.createQueryBuilder('storageObject')
          .setLock('pessimistic_write')
          .where('storageObject.id = :objectId AND storageObject.userId = :userId', { objectId, userId })
          .getOne();
      }
      await versionRepository.delete({ virtualNodeId: In(all.map((item) => item.id)) });
      await nodeRepository.delete(all.map((item) => item.id));
      const unused: string[] = [];
      for (const objectId of objectIds) {
        const object = await objectRepository.findOne({ where: { id: objectId, userId } });
        if (!object) continue;
        const remainingReferences = await versionRepository.count({ where: { storageObjectId: objectId } });
        object.referenceCount = remainingReferences;
        if (remainingReferences === 0) {
          object.lifecycleStatus = 'DELETING';
          object.status = StorageObjectStatus.DELETING;
          unused.push(objectId);
        }
        await objectRepository.save(object);
      }
      return unused;
    });

    const physicalReplicas = unusedObjectIds.length
      ? await this.replicas.find({ where: unusedObjectIds.map((storageObjectId) => ({ storageObjectId })) })
      : [];
    const replicatedObjects = new Set(physicalReplicas.map((replica) => replica.storageObjectId));
    const objectsWithoutReplicas = unusedObjectIds.filter((objectId) => !replicatedObjects.has(objectId));
    if (objectsWithoutReplicas.length) await this.objects.delete(objectsWithoutReplicas);
    for (const replica of physicalReplicas) {
      replica.status = StorageReplicaStatus.DELETING;
      await this.replicas.save(replica);
      await this.queue.enqueue({ replicaId: replica.id, action: 'DELETE' });
    }
    await this.audit.record(userId, physicalReplicas.length ? 'VIRTUAL_NODE_PERMANENT_DELETE_QUEUED' : 'VIRTUAL_NODE_PERMANENTLY_DELETED', 'VirtualNode', id, {
      descendants: descendants.length,
      replicas: physicalReplicas.length,
      retainedSharedObjects: objectIds.length - unusedObjectIds.length,
    });
    return { deleted: true };
  }

  async recent(userId: string): Promise<VirtualNodeResponse[]> {
    const nodes = await this.nodes.find({ where: { userId, deletedAt: IsNull() }, order: { lastAccessedAt: 'DESC', updatedAt: 'DESC' }, take: 50 });
    return nodes.filter((node) => !node.isRoot && node.lastAccessedAt).map((node) => this.toResponse(node));
  }

  async versionHistory(userId: string, id: string): Promise<Array<{
    id: string;
    versionNumber: number;
    size: number;
    checksum: string;
    createdAt: Date;
    comment: string | null;
    current: boolean;
  }>> {
    const node = await this.findOwned(id, userId);
    if (node.type !== VirtualNodeType.FILE) throw new BadRequestException('Version history is only available for files');
    const versions = await this.fileVersions.find({ where: { virtualNodeId: node.id }, order: { versionNumber: 'DESC' } });
    return versions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      size: Number(version.size),
      checksum: version.checksum,
      createdAt: version.createdAt,
      comment: version.comment,
      current: version.id === node.currentVersionId,
    }));
  }

  async restoreVersion(userId: string, id: string, versionId: string): Promise<VirtualNodeResponse> {
    const ownedNode = await this.findOwned(id, userId);
    if (ownedNode.type !== VirtualNodeType.FILE) throw new BadRequestException('Only files can restore versions');
    const restored = await this.dataSource.transaction(async (manager) => {
      const nodeRepository = manager.getRepository(VirtualNode);
      const objectRepository = manager.getRepository(StorageObject);
      const versionRepository = manager.getRepository(FileVersion);
      const node = await nodeRepository.createQueryBuilder('virtualNode')
        .setLock('pessimistic_write')
        .where('virtualNode.id = :id AND virtualNode.userId = :userId AND virtualNode.deletedAt IS NULL', { id, userId })
        .getOne();
      if (!node || node.type !== VirtualNodeType.FILE) throw new NotFoundException('Virtual file not found');
      const source = await versionRepository.findOne({ where: { id: versionId, virtualNodeId: node.id } });
      if (!source) throw new NotFoundException('File version not found');
      const object = await objectRepository.createQueryBuilder('storageObject')
        .setLock('pessimistic_write')
        .where('storageObject.id = :objectId AND storageObject.userId = :userId AND storageObject.lifecycleStatus = :active', {
          objectId: source.storageObjectId,
          userId,
          active: 'ACTIVE',
        })
        .getOne();
      if (!object) throw new NotFoundException('Version content is no longer available');
      const latest = await versionRepository.findOne({ where: { virtualNodeId: node.id }, order: { versionNumber: 'DESC' } });
      object.referenceCount += 1;
      await objectRepository.save(object);
      const version = await versionRepository.save(versionRepository.create({
        virtualNodeId: node.id,
        storageObjectId: object.id,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        size: source.size,
        checksum: source.checksum,
        createdBy: userId,
        comment: `Restored from version ${source.versionNumber}`,
      }));
      node.storageObjectId = object.id;
      node.currentVersionId = version.id;
      node.size = source.size;
      node.mimeType = object.mimeType;
      node.status = object.status as unknown as VirtualNodeStatus;
      return { node: await nodeRepository.save(node), version };
    });
    await this.audit.record(userId, 'VIRTUAL_FILE_VERSION_RESTORED', 'VirtualNode', id, {
      sourceVersionId: versionId,
      versionNumber: restored.version.versionNumber,
    });
    return this.toResponse(restored.node);
  }

  async favorites(userId: string): Promise<VirtualNodeResponse[]> {
    const nodes = await this.nodes.find({ where: { userId, isFavorite: true, deletedAt: IsNull() }, order: { name: 'ASC' } });
    return nodes.map((node) => this.toResponse(node));
  }

  async trashList(userId: string): Promise<VirtualNodeResponse[]> {
    const nodes = await this.nodes.find({ where: { userId }, order: { deletedAt: 'DESC', name: 'ASC' } });
    return nodes.filter((node) => Boolean(node.deletedAt)).map((node) => this.toResponse(node));
  }

  async setFavorite(userId: string, id: string, favorite: boolean): Promise<VirtualNodeResponse> {
    const node = await this.findOwned(id, userId);
    node.isFavorite = favorite;
    const saved = await this.nodes.save(node);
    await this.audit.record(userId, favorite ? 'VIRTUAL_NODE_FAVORITED' : 'VIRTUAL_NODE_UNFAVORITED', 'VirtualNode', id);
    return this.toResponse(saved);
  }

  async storageOverview(userId: string): Promise<{
    logicalBytes: number;
    physicalBytes: number;
    logicalFiles: number;
    deduplicatedBytes: number;
    deduplicatedFiles: number;
    replicas: number;
    healthyReplicas: number;
    degradedObjects: number;
  }> {
    const files = await this.nodes.find({ where: { userId, type: VirtualNodeType.FILE, deletedAt: IsNull() } });
    const objectIds = [...new Set(files.map((file) => file.storageObjectId).filter((value): value is string => Boolean(value)))];
    const objects = objectIds.length ? await this.objects.find({ where: objectIds.map((id) => ({ id, userId })) }) : [];
    const replicas = objectIds.length ? await this.replicas.find({ where: objectIds.map((storageObjectId) => ({ storageObjectId })) }) : [];
    const logicalBytes = files.reduce((sum, file) => sum + Number(file.size ?? 0), 0);
    const uniqueBytes = objects.reduce((sum, object) => sum + Number(object.size), 0);
    return {
      logicalBytes,
      physicalBytes: replicas.filter((replica) => Boolean(replica.remoteFileId)).reduce((sum, replica) => sum + Number(replica.size ?? 0), 0),
      logicalFiles: files.length,
      deduplicatedBytes: Math.max(0, logicalBytes - uniqueBytes),
      deduplicatedFiles: Math.max(0, files.length - objectIds.length),
      replicas: replicas.length,
      healthyReplicas: replicas.filter((replica) => replica.status === StorageReplicaStatus.HEALTHY).length,
      degradedObjects: objects.filter((object) => object.status !== StorageObjectStatus.AVAILABLE).length,
    };
  }

  async accountImpact(userId: string, accountId: string): Promise<{
    accountId: string;
    provider: string;
    status: string;
    affectedFiles: number;
    healthyReplicas: number;
    warning: string;
  }> {
    const account = await this.accounts.getOwnedAccount(userId, accountId);
    const replicas = await this.replicas.find({ where: { cloudAccountId: accountId } });
    const affected = new Set(replicas.map((replica) => replica.storageObjectId));
    const healthy = replicas.filter((replica) => replica.status === StorageReplicaStatus.HEALTHY).length;
    return {
      accountId,
      provider: account.provider,
      status: account.status,
      affectedFiles: affected.size,
      healthyReplicas: healthy,
      warning: affected.size === 0 ? 'Esta cuenta no tiene réplicas de CloudFusion.' : healthy === replicas.length ? 'Desconectar puede dejar archivos sin acceso físico hasta completar un rebalanceo.' : 'Hay réplicas ya degradadas en esta cuenta; realiza un rebalanceo antes de desconectarla.',
    };
  }

  private async ensureRoot(userId: string): Promise<VirtualNode> {
    const existing = await this.nodes.findOne({ where: { userId, isRoot: true, deletedAt: IsNull() } });
    if (existing) return existing;
    return this.nodes.save(this.nodes.create({
      userId,
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
    }));
  }

  private async ensureDefaultPolicy(userId: string): Promise<StoragePolicy> {
    const existing = await this.policies.findOne({ where: { userId, enabled: true }, order: { createdAt: 'ASC' } });
    if (existing) return existing;
    const factor = Math.max(1, Math.min(8, this.config.get<number>('virtualDrive.defaultReplicationFactor') ?? 1));
    return this.policies.save(this.policies.create({ userId, name: 'Default', type: factor > 1 ? StoragePolicyType.REDUNDANT : StoragePolicyType.STANDARD, replicationFactor: factor, enabled: true }));
  }

  private selectDestinations(accounts: CloudAccountPublic[], factor: number, size: number): CloudAccountPublic[] {
    const connected = accounts.filter((account) => account.status === 'CONNECTED' && (account.storage.total == null || account.storage.total - account.storage.used >= size));
    const selected: CloudAccountPublic[] = [];
    for (const account of connected.sort((a, b) => (b.storage.total == null ? -1 : b.storage.total - b.storage.used) - (a.storage.total == null ? -1 : a.storage.total - a.storage.used))) {
      if (selected.some((item) => item.id === account.id)) continue;
      if (factor > 1 && selected.some((item) => item.provider === account.provider)) continue;
      selected.push(account);
      if (selected.length >= factor) break;
    }
    return selected;
  }

  private async findOwned(id: string, userId: string, includeDeleted = false): Promise<VirtualNode> {
    const node = await this.nodes.findOne({ where: { id, userId, ...(includeDeleted ? {} : { deletedAt: IsNull() }) } });
    if (!node) throw new NotFoundException('Virtual node not found');
    return node;
  }

  private async ensureAvailableName(userId: string, parentId: string | null, name: string, exceptId?: string): Promise<void> {
    const where = { userId, parentId: parentId ?? IsNull(), name, deletedAt: IsNull() };
    const existing = await this.nodes.findOne({ where });
    if (existing && existing.id !== exceptId) throw new ConflictException('A node with that name already exists in the destination');
  }

  private async isDescendant(candidateParentId: string, nodeId: string, userId: string): Promise<boolean> {
    let cursor = await this.nodes.findOne({ where: { id: candidateParentId, userId } });
    while (cursor?.parentId) {
      if (cursor.parentId === nodeId) return true;
      cursor = await this.nodes.findOne({ where: { id: cursor.parentId, userId } });
    }
    return false;
  }

  private async collectTree(userId: string, parent: VirtualNode, includeDeleted = false): Promise<VirtualNode[]> {
    const result: VirtualNode[] = [];
    const children = await this.nodes.find({ where: { userId, parentId: parent.id, ...(includeDeleted ? {} : { deletedAt: IsNull() }) }, order: { createdAt: 'ASC' } });
    for (const child of children) {
      result.push(child, ...(await this.collectTree(userId, child, includeDeleted)));
    }
    return result;
  }

  private cleanName(value: string): string {
    const name = value.trim();
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new BadRequestException('Invalid virtual node name');
    return name;
  }

  private toResponse(node: VirtualNode): VirtualNodeResponse {
    return {
      id: node.id,
      userId: node.userId,
      parentId: node.parentId,
      name: node.name,
      type: node.type,
      mimeType: node.mimeType,
      size: node.size == null ? null : Number(node.size),
      status: node.status,
      storageObjectId: node.storageObjectId,
      currentVersionId: node.currentVersionId,
      isRoot: node.isRoot,
      isFavorite: node.isFavorite,
      deletedAt: node.deletedAt,
      lastAccessedAt: node.lastAccessedAt,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  }
}
