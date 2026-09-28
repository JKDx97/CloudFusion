import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { CloudAccountService, CloudAccountPublic } from '../cloud-accounts/cloud-account.service';
import { StorageObject } from './entities/storage-object.entity';
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
  isRoot: boolean;
  isFavorite: boolean;
  deletedAt: Date | null;
  lastAccessedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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
    const object = await this.objects.findOne({ where: { id: node.storageObjectId, userId } });
    if (!object) throw new NotFoundException('Storage object not found');
    const replicas = await this.replicas.find({ where: { storageObjectId: object.id }, order: { status: 'ASC', lastVerifiedAt: 'DESC' } });
    let failures = 0;
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
        return download;
      } catch (error) {
        failures += 1;
        replica.status = StorageReplicaStatus.DEGRADED;
        replica.lastError = error instanceof Error ? error.message : 'Replica download failed';
        await this.replicas.save(replica);
      }
    }
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

  async upload(userId: string, file: Express.Multer.File, parentId?: string): Promise<{
    node: VirtualNodeResponse;
    queued: boolean;
    replicas: number;
    warning?: string;
  }> {
    if (!file) throw new BadRequestException('A file is required');
    const parent = parentId ? await this.findOwned(parentId, userId) : await this.ensureRoot(userId);
    if (parent.type !== VirtualNodeType.FOLDER) throw new BadRequestException('Parent node must be a folder');
    const name = this.cleanName(file.originalname);
    await this.ensureAvailableName(userId, parent.id, name);
    const policy = await this.ensureDefaultPolicy(userId);
    const checksum = await this.checksum(file.path);
    const storageObject = await this.objects.save(this.objects.create({
      userId,
      storageKey: `objects/${crypto.randomUUID()}`,
      size: String(file.size),
      mimeType: file.mimetype || null,
      checksum,
      checksumAlgorithm: 'SHA-256',
      status: StorageObjectStatus.UPLOADING,
      policyId: policy.id,
    }));
    const node = await this.nodes.save(this.nodes.create({
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
    const destinations = this.selectDestinations(await this.accounts.list(userId), policy.replicationFactor, file.size);
    if (destinations.length === 0) {
      storageObject.status = StorageObjectStatus.UNAVAILABLE;
      node.status = VirtualNodeStatus.UNAVAILABLE;
      await this.objects.save(storageObject);
      await this.nodes.save(node);
      await unlink(file.path).catch(() => undefined);
      await this.audit.record(userId, 'VIRTUAL_UPLOAD_UNAVAILABLE', 'VirtualNode', node.id, { reason: 'NO_CONNECTED_STORAGE_ACCOUNT' });
      return { node: this.toResponse(node), queued: false, replicas: 0, warning: 'Conecta al menos una cuenta cloud para guardar físicamente el archivo.' };
    }
    const replicaEntities = await this.replicas.save(destinations.map((account) => this.replicas.create({
      storageObjectId: storageObject.id,
      cloudAccountId: account.id,
      provider: account.provider,
      remoteFileId: null,
      remoteParentId: null,
      status: StorageReplicaStatus.PENDING,
      size: String(file.size),
      checksum,
      lastVerifiedAt: null,
      lastError: null,
      attempts: 0,
    })));
    let queued = true;
    for (const replica of replicaEntities) {
      try {
        await this.queue.enqueue({ replicaId: replica.id, stagingPath: file.path });
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
    await this.audit.record(userId, 'VIRTUAL_UPLOAD_QUEUED', 'VirtualNode', node.id, { replicationFactor: replicaEntities.length });
    return { node: this.toResponse(node), queued, replicas: replicaEntities.length };
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
    const objectIds = all.map((item) => item.storageObjectId).filter((value): value is string => Boolean(value));
    const physicalReplicas = objectIds.length ? await this.replicas.find({ where: objectIds.map((storageObjectId) => ({ storageObjectId })) }) : [];
    if (physicalReplicas.length === 0) {
      if (objectIds.length) await this.objects.delete(objectIds);
      await this.nodes.delete(all.map((item) => item.id));
      await this.audit.record(userId, 'VIRTUAL_NODE_PERMANENTLY_DELETED', 'VirtualNode', id, { descendants: descendants.length, queued: false });
      return { deleted: true };
    }
    for (const item of all) {
      item.status = VirtualNodeStatus.DELETING;
      await this.nodes.save(item);
    }
    for (const objectId of objectIds) {
      const object = await this.objects.findOne({ where: { id: objectId, userId } });
      if (object) {
        object.status = StorageObjectStatus.DELETING;
        await this.objects.save(object);
      }
    }
    for (const replica of physicalReplicas) {
      replica.status = StorageReplicaStatus.DELETING;
      await this.replicas.save(replica);
      await this.queue.enqueue({ replicaId: replica.id, action: 'DELETE', rootNodeId: node.id });
    }
    await this.audit.record(userId, 'VIRTUAL_NODE_PERMANENT_DELETE_QUEUED', 'VirtualNode', id, { descendants: descendants.length, replicas: physicalReplicas.length });
    return { deleted: true };
  }

  async recent(userId: string): Promise<VirtualNodeResponse[]> {
    const nodes = await this.nodes.find({ where: { userId, deletedAt: IsNull() }, order: { lastAccessedAt: 'DESC', updatedAt: 'DESC' }, take: 50 });
    return nodes.filter((node) => !node.isRoot && node.lastAccessedAt).map((node) => this.toResponse(node));
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
    replicas: number;
    healthyReplicas: number;
    degradedObjects: number;
  }> {
    const objects = await this.objects.find({ where: { userId } });
    const objectIds = objects.map((object) => object.id);
    const replicas = objectIds.length ? await this.replicas.find({ where: objectIds.map((storageObjectId) => ({ storageObjectId })) }) : [];
    return {
      logicalBytes: objects.reduce((sum, object) => sum + Number(object.size), 0),
      physicalBytes: replicas.filter((replica) => Boolean(replica.remoteFileId)).reduce((sum, replica) => sum + Number(replica.size ?? 0), 0),
      logicalFiles: objects.length,
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

  private async checksum(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
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
      isRoot: node.isRoot,
      isFavorite: node.isFavorite,
      deletedAt: node.deletedAt,
      lastAccessedAt: node.lastAccessedAt,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  }
}
