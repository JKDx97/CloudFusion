import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { CloudAccountService } from '../cloud-accounts/cloud-account.service';
import { StorageObject } from './entities/storage-object.entity';
import { StorageReplica } from './entities/storage-replica.entity';
import { StoragePolicy } from './entities/storage-policy.entity';
import { StorageReplicaStatus } from './enums/storage-replica-status.enum';
import { ReplicationQueueService } from './replication-queue.service';
import { pipeline } from 'node:stream/promises';
import { CloudAccountStatus } from '../providers/common/cloud-provider.enum';
import { StorageObjectStatus } from './enums/storage-object-status.enum';

@Injectable()
export class ReplicaHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReplicaHealthService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(StorageObject) private readonly objects: Repository<StorageObject>,
    @InjectRepository(StorageReplica) private readonly replicas: Repository<StorageReplica>,
    @InjectRepository(StoragePolicy) private readonly policies: Repository<StoragePolicy>,
    private readonly accounts: CloudAccountService,
    private readonly queue: ReplicationQueueService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const hours = Math.max(1, this.config.get<number>('virtualDrive.verifyIntervalHours') ?? 24);
    this.timer = setInterval(() => void this.verifyDueReplicas(), hours * 60 * 60 * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async verify(replicaId: string, userId: string): Promise<StorageReplica> {
    const replica = await this.replicas.findOne({ where: { id: replicaId } });
    if (!replica) throw new Error('Replica not found');
    const object = await this.objects.findOne({ where: { id: replica.storageObjectId, userId } });
    if (!object) throw new Error('Replica not found');
    await this.verifyReplica(replica, object);
    return (await this.replicas.findOne({ where: { id: replica.id } })) ?? replica;
  }

  async verifyDueReplicas(): Promise<void> {
    const interval = (this.config.get<number>('virtualDrive.verifyIntervalHours') ?? 24) * 60 * 60 * 1000;
    const replicas = await this.replicas.find({ where: [{ status: StorageReplicaStatus.HEALTHY }, { status: StorageReplicaStatus.DEGRADED }] });
    for (const replica of replicas) {
      if (!replica.lastVerifiedAt || Date.now() - replica.lastVerifiedAt.getTime() >= interval) {
        const object = await this.objects.findOne({ where: { id: replica.storageObjectId } });
        if (object) await this.verifyReplica(replica, object).catch((error) => this.logger.warn(`Replica verification failed: ${String(error)}`));
      }
    }
  }

  async rebalance(userId: string): Promise<{ queued: number; skipped: number }> {
    const objects = await this.objects.find({ where: { userId, status: StorageObjectStatus.DEGRADED } });
    const accounts = (await this.accounts.list(userId)).filter((account) => account.status === CloudAccountStatus.CONNECTED);
    let queued = 0;
    let skipped = 0;
    for (const object of objects) {
      const policy = object.policyId ? await this.policies.findOne({ where: { id: object.policyId } }) : null;
      const required = policy?.replicationFactor ?? 1;
      const existing = await this.replicas.find({ where: { storageObjectId: object.id } });
      const healthy = existing.filter((replica) => replica.status === StorageReplicaStatus.HEALTHY).length;
      const needed = Math.max(0, required - healthy);
      if (needed === 0) continue;
      const source = existing.find((replica) => replica.status === StorageReplicaStatus.HEALTHY && replica.remoteFileId);
      if (!source?.remoteFileId) {
        skipped += 1;
        continue;
      }
      const candidates = accounts.filter((account) => !existing.some((replica) => replica.cloudAccountId === account.id) && (required === 1 || !existing.some((replica) => replica.provider === account.provider)));
      for (const account of candidates.slice(0, needed)) {
        try {
          const sourceContext = await this.accounts.getAuthorizedAccount(userId, source.cloudAccountId);
          const download = await sourceContext.adapter.downloadFile(sourceContext.accessToken, sourceContext.account.id, source.remoteFileId);
          const directory = join(tmpdir(), 'cloudfusion-repairs');
          await mkdir(directory, { recursive: true });
          const stagingPath = join(directory, `${object.id}-rebalance-${account.id}-${Date.now()}`);
          await pipeline(download.stream, createWriteStream(stagingPath));
          const target = await this.replicas.save(this.replicas.create({
            storageObjectId: object.id,
            cloudAccountId: account.id,
            provider: account.provider,
            remoteFileId: null,
            remoteParentId: null,
            status: StorageReplicaStatus.REPAIRING,
            size: object.size,
            checksum: object.checksum,
            lastVerifiedAt: null,
            lastError: null,
            attempts: 0,
          }));
          await this.queue.enqueue({ replicaId: target.id, stagingPath });
          queued += 1;
          await this.audit.record(userId, 'STORAGE_REBALANCE_QUEUED', 'StorageObject', object.id, { targetAccountId: account.id, replicaId: target.id });
        } catch (error) {
          skipped += 1;
          this.logger.warn(`Could not rebalance storage object ${object.id}: ${String(error)}`);
        }
      }
    }
    return { queued, skipped };
  }

  private async verifyReplica(replica: StorageReplica, object: StorageObject): Promise<void> {
    try {
      const context = await this.accounts.getAuthorizedAccount(object.userId, replica.cloudAccountId);
      if (!replica.remoteFileId) throw new Error('Replica has no remote file id');
      const remote = await context.adapter.getFile(context.accessToken, context.account.id, replica.remoteFileId);
      if (remote.type !== 'file' || (remote.size != null && remote.size !== Number(object.size))) throw new Error('Remote replica size mismatch');
      const download = await context.adapter.downloadFile(context.accessToken, context.account.id, replica.remoteFileId);
      const hash = createHash('sha256');
      for await (const chunk of download.stream) hash.update(chunk as Buffer);
      const checksum = hash.digest('hex');
      if (checksum !== object.checksum) {
        replica.status = StorageReplicaStatus.CORRUPTED;
        replica.lastError = 'SHA-256 checksum mismatch';
        await this.replicas.save(replica);
        await this.audit.record(object.userId, 'REPLICA_CORRUPTED', 'StorageReplica', replica.id, { storageObjectId: object.id });
        await this.queueRepair(replica, object);
        return;
      }
      replica.status = StorageReplicaStatus.HEALTHY;
      replica.size = String(remote.size ?? object.size);
      replica.checksum = checksum;
      replica.lastVerifiedAt = new Date();
      replica.lastError = null;
      await this.replicas.save(replica);
      await this.audit.record(object.userId, 'REPLICA_VERIFIED', 'StorageReplica', replica.id, { storageObjectId: object.id });
    } catch (error) {
      replica.status = StorageReplicaStatus.MISSING;
      replica.lastError = error instanceof Error ? error.message : 'Replica verification failed';
      await this.replicas.save(replica);
      await this.audit.record(object.userId, 'REPLICA_MISSING', 'StorageReplica', replica.id, { storageObjectId: object.id });
      await this.queueRepair(replica, object);
    }
  }

  private async queueRepair(target: StorageReplica, object: StorageObject): Promise<void> {
    if (this.config.get<boolean>('virtualDrive.autoRepair') === false) return;
    const source = await this.replicas.findOne({ where: { storageObjectId: object.id, status: StorageReplicaStatus.HEALTHY } });
    if (!source || source.id === target.id || !source.remoteFileId) return;
    const context = await this.accounts.getAuthorizedAccount(object.userId, source.cloudAccountId);
    const download = await context.adapter.downloadFile(context.accessToken, context.account.id, source.remoteFileId);
    const directory = join(tmpdir(), 'cloudfusion-repairs');
    await mkdir(directory, { recursive: true });
    const stagingPath = join(directory, `${object.id}-${target.id}-${Date.now()}`);
    await pipeline(download.stream, createWriteStream(stagingPath));
    target.status = StorageReplicaStatus.REPAIRING;
    target.lastError = null;
    await this.replicas.save(target);
    await this.queue.enqueue({ replicaId: target.id, stagingPath });
    await this.audit.record(object.userId, 'REPLICA_REPAIR_QUEUED', 'StorageReplica', target.id, { sourceReplicaId: source.id, storageObjectId: object.id });
  }
}
