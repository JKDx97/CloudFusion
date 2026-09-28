import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { StorageObject } from '../virtual-fs/entities/storage-object.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { StorageObjectStatus } from '../virtual-fs/enums/storage-object-status.enum';
import { VirtualNodeStatus } from '../virtual-fs/enums/virtual-node-status.enum';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';
import { CreateSnapshotDto } from './dto/create-snapshot.dto';
import { SnapshotRestoreStrategy } from './dto/restore-snapshot-entry.dto';
import { Snapshot } from './entities/snapshot.entity';
import { SnapshotEntry } from './entities/snapshot-entry.entity';

@Injectable()
export class SnapshotsService {
  constructor(
    @InjectRepository(Snapshot) private readonly snapshots: Repository<Snapshot>,
    @InjectRepository(SnapshotEntry) private readonly entries: Repository<SnapshotEntry>,
    @InjectRepository(VirtualNode) private readonly nodes: Repository<VirtualNode>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, dto: CreateSnapshotDto): Promise<Snapshot> {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Snapshot name is required');
    const snapshot = await this.snapshots.save(this.snapshots.create({
      userId,
      name,
      description: dto.description?.trim() || null,
      status: 'CREATING',
      isImmutable: dto.isImmutable ?? false,
      nodeCount: 0,
      logicalSize: '0',
      completedAt: null,
    }));

    try {
      const completed = await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
        const nodes = await manager.getRepository(VirtualNode).find({
          where: { userId, deletedAt: IsNull() },
          order: { createdAt: 'ASC' },
        });
        const orderedNodes = this.topologicalOrder(nodes);
        const fileNodes = orderedNodes.filter((node) => node.type === VirtualNodeType.FILE);
        const versionIds = fileNodes.map((node) => node.currentVersionId).filter((id): id is string => Boolean(id));
        const versions = versionIds.length
          ? await manager.getRepository(FileVersion).find({ where: { id: In(versionIds) } })
          : [];
        const versionsById = new Map(versions.map((version) => [version.id, version]));
        const entryIds = new Map<string, string>();
        const entries = orderedNodes.map((node) => {
          let fileVersionId: string | null = null;
          if (node.type === VirtualNodeType.FILE) {
            const version = node.currentVersionId ? versionsById.get(node.currentVersionId) : undefined;
            if (!version || version.virtualNodeId !== node.id) {
              throw new BadRequestException(`Cannot snapshot file without a valid current version: ${node.name}`);
            }
            fileVersionId = version.id;
          }
          const entry = manager.getRepository(SnapshotEntry).create({
            id: randomUUID(),
            snapshotId: snapshot.id,
            virtualNodeId: node.id,
            parentSnapshotEntryId: node.parentId ? entryIds.get(node.parentId) ?? null : null,
            fileVersionId,
            name: node.name,
            type: node.type,
            isRoot: node.isRoot,
            mimeType: node.mimeType,
            size: node.size,
          });
          entryIds.set(node.id, entry.id);
          return entry;
        });
        const entryRepository = manager.getRepository(SnapshotEntry);
        for (let offset = 0; offset < entries.length; offset += 500) {
          await entryRepository.save(entries.slice(offset, offset + 500));
        }
        const saved = await manager.getRepository(Snapshot).findOne({ where: { id: snapshot.id, userId } });
        if (!saved) throw new NotFoundException('Snapshot not found');
        saved.status = 'AVAILABLE';
        saved.nodeCount = entries.length;
        saved.logicalSize = String(fileNodes.reduce((sum, node) => sum + Number(node.size ?? 0), 0));
        saved.completedAt = new Date();
        return manager.getRepository(Snapshot).save(saved);
      });
      await this.audit.record(userId, 'SNAPSHOT_CREATED', 'Snapshot', completed.id, {
        nodeCount: completed.nodeCount,
        logicalSize: Number(completed.logicalSize),
        isImmutable: completed.isImmutable,
      });
      return completed;
    } catch (error) {
      await this.snapshots.update({ id: snapshot.id, userId }, { status: 'FAILED', completedAt: new Date() });
      await this.audit.record(userId, 'SNAPSHOT_FAILED', 'Snapshot', snapshot.id);
      throw error;
    }
  }

  async list(userId: string): Promise<Snapshot[]> {
    return this.snapshots.find({ where: { userId }, order: { createdAt: 'DESC' }, take: 100 });
  }

  async getEntries(userId: string, snapshotId: string): Promise<Array<{
    id: string;
    parentEntryId: string | null;
    virtualNodeId: string | null;
    fileVersionId: string | null;
    name: string;
    type: 'FILE' | 'FOLDER';
    isRoot: boolean;
    mimeType: string | null;
    size: number | null;
  }>> {
    await this.requireSnapshot(userId, snapshotId);
    const entries = await this.entries.find({ where: { snapshotId }, order: { name: 'ASC' } });
    return entries.map((entry) => ({
      id: entry.id,
      parentEntryId: entry.parentSnapshotEntryId,
      virtualNodeId: entry.virtualNodeId,
      fileVersionId: entry.fileVersionId,
      name: entry.name,
      type: entry.type,
      isRoot: entry.isRoot,
      mimeType: entry.mimeType,
      size: entry.size == null ? null : Number(entry.size),
    }));
  }

  async delete(userId: string, snapshotId: string): Promise<{ deleted: true }> {
    const snapshot = await this.requireSnapshot(userId, snapshotId);
    if (snapshot.isImmutable) throw new BadRequestException('Immutable snapshots cannot be deleted');
    snapshot.status = 'DELETING';
    await this.snapshots.save(snapshot);
    await this.snapshots.delete({ id: snapshot.id, userId });
    await this.audit.record(userId, 'SNAPSHOT_DELETED', 'Snapshot', snapshotId);
    return { deleted: true };
  }

  async restoreEntry(
    userId: string,
    snapshotId: string,
    entryId: string,
    strategy: SnapshotRestoreStrategy = 'RESTORE_RENAME',
    targetParentId?: string,
  ): Promise<{ status: 'RESTORED' | 'SKIPPED'; nodeId?: string; name?: string }> {
    const snapshot = await this.requireSnapshot(userId, snapshotId);
    if (snapshot.status !== 'AVAILABLE') throw new BadRequestException('Only completed snapshots can be restored');
    const entry = await this.entries.findOne({ where: { id: entryId, snapshotId } });
    if (!entry) throw new NotFoundException('Snapshot entry not found');
    if (entry.isRoot) throw new BadRequestException('Restore a drive root entry by restoring a child or the full snapshot');

    const parentEntry = entry.parentSnapshotEntryId
      ? await this.entries.findOne({ where: { id: entry.parentSnapshotEntryId, snapshotId } })
      : null;
    const requestedParentId = targetParentId ?? parentEntry?.virtualNodeId ?? undefined;
    let parent = requestedParentId
      ? await this.nodes.findOne({ where: { id: requestedParentId, userId, deletedAt: IsNull() } })
      : null;
    if (!parent || parent.type !== VirtualNodeType.FOLDER) {
      parent = await this.nodes.findOne({ where: { userId, isRoot: true, deletedAt: IsNull() } });
    }
    if (!parent) throw new NotFoundException('Virtual drive root not found');
    const originalName = this.cleanName(entry.name);

    const restored = await this.dataSource.transaction(async (manager) => {
      const nodeRepository = manager.getRepository(VirtualNode);
      const versionRepository = manager.getRepository(FileVersion);
      const objectRepository = manager.getRepository(StorageObject);
      let name = originalName;
      let conflict: VirtualNode | null = null;
      for (let suffix = 0; suffix < 1000; suffix += 1) {
        await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`snapshot-restore:${userId}:${parent!.id}:${name}`]);
        conflict = await nodeRepository.findOne({ where: { userId, parentId: parent!.id, name, deletedAt: IsNull() } });
        if (!conflict || strategy !== 'RESTORE_RENAME') break;
        name = this.restoredName(originalName, suffix + 1);
      }
      if (conflict && strategy === 'RESTORE_SKIP') return { status: 'SKIPPED' as const };
      if (conflict && strategy === 'RESTORE_RENAME') throw new ConflictException('Could not allocate a unique restored name');
      if (conflict && strategy === 'RESTORE_OVERWRITE' && conflict.type !== entry.type) {
        throw new BadRequestException('Cannot overwrite a node of a different type');
      }
      if (conflict && strategy === 'RESTORE_OVERWRITE' && entry.type === 'FOLDER') {
        return { status: 'RESTORED' as const, nodeId: conflict.id, name: conflict.name };
      }

      if (entry.type === 'FOLDER') {
        const folder = await nodeRepository.save(nodeRepository.create({
          id: randomUUID(),
          userId,
          parentId: parent!.id,
          name,
          type: VirtualNodeType.FOLDER,
          mimeType: 'inode/directory',
          size: null,
          status: VirtualNodeStatus.AVAILABLE,
          storageObjectId: null,
          currentVersionId: null,
          deletedAt: null,
          previousParentId: null,
          isRoot: false,
          isFavorite: false,
          lastAccessedAt: null,
        }));
        return { status: 'RESTORED' as const, nodeId: folder.id, name: folder.name };
      }

      if (!entry.fileVersionId) throw new BadRequestException('Snapshot file is missing its version reference');
      const sourceVersion = await versionRepository.findOne({ where: { id: entry.fileVersionId } });
      if (!sourceVersion) throw new NotFoundException('Snapshot file content is no longer available');
      let targetNode = conflict;
      if (targetNode) {
        targetNode = await nodeRepository.createQueryBuilder('virtualNode')
          .setLock('pessimistic_write')
          .where('virtualNode.id = :id AND virtualNode.userId = :userId AND virtualNode.deletedAt IS NULL', { id: targetNode.id, userId })
          .getOne();
        if (!targetNode || targetNode.type !== VirtualNodeType.FILE) throw new BadRequestException('The destination file changed during restore');
      }
      const object = await objectRepository.createQueryBuilder('storageObject')
        .setLock('pessimistic_write')
        .where('storageObject.id = :id AND storageObject.userId = :userId AND storageObject.lifecycleStatus = :active', {
          id: sourceVersion.storageObjectId,
          userId,
          active: 'ACTIVE',
        })
        .getOne();
      if (!object) throw new NotFoundException('Snapshot file content is no longer available');
      if (!targetNode) {
        targetNode = nodeRepository.create({
          id: randomUUID(),
          userId,
          parentId: parent!.id,
          name,
          type: VirtualNodeType.FILE,
          mimeType: entry.mimeType,
          size: sourceVersion.size,
          status: object.status as unknown as VirtualNodeStatus,
          storageObjectId: object.id,
          currentVersionId: null,
          deletedAt: null,
          previousParentId: null,
          isRoot: false,
          isFavorite: false,
          lastAccessedAt: null,
        });
      }
      const latest = targetNode.id
        ? await versionRepository.findOne({ where: { virtualNodeId: targetNode.id }, order: { versionNumber: 'DESC' } })
        : null;
      object.referenceCount += 1;
      await objectRepository.save(object);
      const version = await versionRepository.save(versionRepository.create({
        virtualNodeId: targetNode.id,
        storageObjectId: object.id,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        size: sourceVersion.size,
        checksum: sourceVersion.checksum,
        createdBy: userId,
        comment: `Restored from snapshot ${snapshot.name}`.slice(0, 500),
      }));
      targetNode.storageObjectId = object.id;
      targetNode.currentVersionId = version.id;
      targetNode.size = sourceVersion.size;
      targetNode.mimeType = entry.mimeType ?? object.mimeType;
      targetNode.status = object.status as unknown as VirtualNodeStatus;
      const savedNode = await nodeRepository.save(targetNode);
      return { status: 'RESTORED' as const, nodeId: savedNode.id, name: savedNode.name };
    });
    if (restored.status === 'RESTORED') {
      await this.audit.record(userId, 'SNAPSHOT_ENTRY_RESTORED', 'SnapshotEntry', entry.id, {
        snapshotId,
        nodeId: restored.nodeId,
        strategy,
      });
    }
    return restored;
  }

  private async requireSnapshot(userId: string, snapshotId: string): Promise<Snapshot> {
    const snapshot = await this.snapshots.findOne({ where: { id: snapshotId, userId } });
    if (!snapshot) throw new NotFoundException('Snapshot not found');
    return snapshot;
  }

  private topologicalOrder(nodes: VirtualNode[]): VirtualNode[] {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const childrenByParent = new Map<string, VirtualNode[]>();
    for (const node of nodes) {
      const parentId = node.parentId ?? '';
      const children = childrenByParent.get(parentId) ?? [];
      children.push(node);
      childrenByParent.set(parentId, children);
    }
    const queue = nodes.filter((node) => !node.parentId || !nodesById.has(node.parentId));
    const result: VirtualNode[] = [];
    const visited = new Set<string>();
    for (let index = 0; index < queue.length; index += 1) {
      const node = queue[index];
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      result.push(node);
      queue.push(...(childrenByParent.get(node.id) ?? []));
    }
    for (const node of nodes) if (!visited.has(node.id)) result.push(node);
    return result;
  }

  private cleanName(value: string): string {
    const name = value.trim();
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new BadRequestException('Invalid snapshot entry name');
    }
    return name;
  }

  private restoredName(originalName: string, suffix: number): string {
    const extensionIndex = originalName.lastIndexOf('.');
    const hasExtension = extensionIndex > 0;
    const base = hasExtension ? originalName.slice(0, extensionIndex) : originalName;
    const extension = hasExtension ? originalName.slice(extensionIndex) : '';
    return `${base} (restored${suffix > 1 ? ` ${suffix}` : ''})${extension}`;
  }
}
