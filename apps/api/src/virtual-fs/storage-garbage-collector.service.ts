import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { FileVersion } from './entities/file-version.entity';
import { StorageObject } from './entities/storage-object.entity';
import { StorageReplica } from './entities/storage-replica.entity';
import { SnapshotEntry } from '../snapshots/entities/snapshot-entry.entity';
import { ReplicationQueueService } from './replication-queue.service';
import { StorageReplicaStatus } from './enums/storage-replica-status.enum';

@Injectable()
export class StorageGarbageCollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageGarbageCollectorService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(StorageObject) private readonly objects: Repository<StorageObject>,
    @InjectRepository(StorageReplica) private readonly replicas: Repository<StorageReplica>,
    @InjectRepository(FileVersion) private readonly versions: Repository<FileVersion>,
    @InjectRepository(SnapshotEntry) private readonly snapshotEntries: Repository<SnapshotEntry>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queue: ReplicationQueueService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<boolean>('dataProtection.storageGcEnabled') === false) return;
    const intervalMinutes = Math.max(5, this.config.get<number>('dataProtection.storageGcIntervalMinutes') ?? 60);
    this.timer = setInterval(() => void this.collect().catch((error) => this.logger.warn(`Storage GC pass failed: ${String(error)}`)), intervalMinutes * 60 * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async collect(): Promise<{ orphanedVersionsRemoved: number; marked: number; queuedForDeletion: number; retained: number }> {
    let orphanedVersionsRemoved = 0;
    let marked = 0;
    let queuedForDeletion = 0;
    let retained = 0;
    const orphanedVersions = await this.versions.find({ where: { virtualNodeId: IsNull() } });
    for (const version of orphanedVersions) {
      const pinned = await this.snapshotEntries.count({ where: { fileVersionId: version.id } });
      if (pinned === 0) {
        await this.versions.delete(version.id);
        orphanedVersionsRemoved += 1;
      }
    }

    const candidates = await this.objects.find({ where: [
      { lifecycleStatus: 'ACTIVE' },
      { lifecycleStatus: 'ORPHANED' },
      { lifecycleStatus: 'GC_PENDING' },
    ], take: 500 });
    const graceHours = Math.max(1, this.config.get<number>('dataProtection.storageGcGraceHours') ?? 24);
    const now = new Date();
    for (const candidate of candidates) {
      try {
        const result = await this.dataSource.transaction(async (manager) => {
          const object = await manager.getRepository(StorageObject).createQueryBuilder('storageObject')
            .setLock('pessimistic_write')
            .where('storageObject.id = :id', { id: candidate.id })
            .getOne();
          if (!object) return 'RETAINED' as const;
          const referenceCount = await manager.getRepository(FileVersion).count({ where: { storageObjectId: object.id } });
          object.referenceCount = referenceCount;
          if (referenceCount > 0) {
            object.lifecycleStatus = 'ACTIVE';
            object.gcAfter = null;
            await manager.getRepository(StorageObject).save(object);
            return 'RETAINED' as const;
          }
          if (object.lifecycleStatus !== 'GC_PENDING') {
            object.lifecycleStatus = 'GC_PENDING';
            object.gcAfter = new Date(now.getTime() + graceHours * 60 * 60 * 1000);
            await manager.getRepository(StorageObject).save(object);
            return 'MARKED' as const;
          }
          if (!object.gcAfter || object.gcAfter.getTime() > now.getTime()) return 'RETAINED' as const;
          const finalReferenceCount = await manager.getRepository(FileVersion).count({ where: { storageObjectId: object.id } });
          if (finalReferenceCount > 0) {
            object.referenceCount = finalReferenceCount;
            object.lifecycleStatus = 'ACTIVE';
            object.gcAfter = null;
            await manager.getRepository(StorageObject).save(object);
            return 'RETAINED' as const;
          }
          object.referenceCount = 0;
          object.lifecycleStatus = 'DELETING';
          await manager.getRepository(StorageObject).save(object);
          return 'DELETE' as const;
        });
        if (result === 'RETAINED') { retained += 1; continue; }
        if (result === 'MARKED') {
          marked += 1;
          await this.audit.record(candidate.userId, 'STORAGE_OBJECT_GC_MARKED', 'StorageObject', candidate.id, { graceHours });
          continue;
        }
        const replicas = await this.replicas.find({ where: { storageObjectId: candidate.id } });
        if (replicas.length === 0) {
          await this.objects.delete(candidate.id);
          await this.audit.record(candidate.userId, 'STORAGE_OBJECT_GC_DELETED', 'StorageObject', candidate.id);
          queuedForDeletion += 1;
          continue;
        }
        for (const replica of replicas) {
          replica.status = StorageReplicaStatus.DELETING;
          await this.replicas.save(replica);
          await this.queue.enqueue({ replicaId: replica.id, action: 'DELETE' });
        }
        await this.audit.record(candidate.userId, 'STORAGE_OBJECT_GC_QUEUED', 'StorageObject', candidate.id, { replicaCount: replicas.length });
        queuedForDeletion += 1;
      } catch (error) {
        this.logger.warn(`Could not collect storage object ${candidate.id}: ${String(error)}`);
      }
    }
    return { orphanedVersionsRemoved, marked, queuedForDeletion, retained };
  }
}
