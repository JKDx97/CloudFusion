import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Worker } from 'bullmq';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { CloudAccountService } from '../cloud-accounts/cloud-account.service';
import { ProviderErrorCode, providerHttpError } from '../providers/common/provider-error';
import { StorageObject } from './entities/storage-object.entity';
import { StoragePolicy } from './entities/storage-policy.entity';
import { StorageReplica } from './entities/storage-replica.entity';
import { VirtualNode } from './entities/virtual-node.entity';
import { StorageObjectStatus } from './enums/storage-object-status.enum';
import { StorageReplicaStatus } from './enums/storage-replica-status.enum';
import { VirtualNodeStatus } from './enums/virtual-node-status.enum';
import { ReplicationJobPayload, ReplicationQueueService } from './replication-queue.service';

@Injectable()
export class ReplicationWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReplicationWorkerService.name);
  private worker?: Worker<ReplicationJobPayload>;

  constructor(
    @InjectRepository(StorageObject) private readonly objects: Repository<StorageObject>,
    @InjectRepository(StorageReplica) private readonly replicas: Repository<StorageReplica>,
    @InjectRepository(StoragePolicy) private readonly policies: Repository<StoragePolicy>,
    @InjectRepository(VirtualNode) private readonly nodes: Repository<VirtualNode>,
    private readonly accounts: CloudAccountService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<boolean>('virtualDrive.workerEnabled') === false) return;
    this.worker = new Worker<ReplicationJobPayload>(
      this.config.get<string>('virtualDrive.queueName') ?? 'cloudfusion-replication',
      (job) => this.process(job),
      {
        connection: {
          host: this.config.get<string>('redis.host') ?? 'localhost',
          port: this.config.get<number>('redis.port') ?? 6379,
          maxRetriesPerRequest: null,
        },
        concurrency: Math.max(1, this.config.get<number>('virtualDrive.replicationWorkerConcurrency') ?? 2),
      },
    );
    this.worker.on('error', (error) => this.logger.warn(`Replication worker error: ${error.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<ReplicationJobPayload>): Promise<void> {
    const replica = await this.replicas.findOne({ where: { id: job.data.replicaId } });
    if (!replica) return;
    const object = await this.objects.findOne({ where: { id: replica.storageObjectId } });
    if (!object) return;
    if (job.data.action === 'DELETE') {
      await this.deleteReplica(job, replica, object);
      return;
    }
    if (!job.data.stagingPath) throw new Error('Replication upload is missing its staging path');
    replica.status = StorageReplicaStatus.UPLOADING;
    replica.attempts += 1;
    replica.lastError = null;
    await this.replicas.save(replica);
    try {
      const context = await this.accounts.getAuthorizedAccount(object.userId, replica.cloudAccountId);
      const parent = await this.ensureManagedObjectsFolder(context.accessToken, context.account.id, context.adapter);
      const uploaded = await context.adapter.uploadFile(context.accessToken, context.account.id, {
        stream: createReadStream(job.data.stagingPath),
        name: object.storageKey.split('/').pop() ?? object.id,
        mimeType: object.mimeType ?? 'application/octet-stream',
        size: Number(object.size),
        parentId: parent.id,
      });
      replica.remoteFileId = uploaded.id;
      replica.remoteParentId = parent.id;
      replica.provider = context.account.provider;
      replica.size = String(uploaded.size ?? object.size);
      replica.checksum = object.encryptedChecksum ?? object.checksum;
      replica.status = StorageReplicaStatus.HEALTHY;
      replica.lastVerifiedAt = new Date();
      await this.replicas.save(replica);
      await this.updateLogicalState(object);
      await this.cleanupStaging(object.id, job.data.stagingPath);
      await this.audit.record(object.userId, 'REPLICA_UPLOADED', 'StorageReplica', replica.id, { provider: replica.provider, storageObjectId: object.id });
    } catch (error) {
      replica.status = StorageReplicaStatus.FAILED;
      replica.lastError = error instanceof Error ? error.message : 'Replica upload failed';
      await this.replicas.save(replica);
      await this.updateLogicalState(object);
      if (this.shouldRetry(error, job)) throw error;
      await this.cleanupStaging(object.id, job.data.stagingPath);
      await this.audit.record(object.userId, 'REPLICA_UPLOAD_FAILED', 'StorageReplica', replica.id, { storageObjectId: object.id });
    }
  }

  private async deleteReplica(job: Job<ReplicationJobPayload>, replica: StorageReplica, object: StorageObject): Promise<void> {
    try {
      if (replica.remoteFileId) {
        const context = await this.accounts.getAuthorizedAccount(object.userId, replica.cloudAccountId);
        await context.adapter.deleteItem(context.accessToken, context.account.id, replica.remoteFileId);
      }
      await this.replicas.delete(replica.id);
      await this.finalizeDeletedObject(object.userId, object.id);
      await this.audit.record(object.userId, 'REPLICA_DELETED', 'StorageReplica', replica.id, { storageObjectId: object.id });
    } catch (error) {
      replica.status = StorageReplicaStatus.FAILED;
      replica.lastError = error instanceof Error ? error.message : 'Replica deletion failed';
      await this.replicas.save(replica);
      throw error;
    }
  }

  private async finalizeDeletedObject(userId: string, objectId: string): Promise<void> {
    const object = await this.objects.findOne({ where: { id: objectId, userId } });
    if (!object || object.referenceCount > 0 || object.lifecycleStatus !== 'DELETING') return;
    const replicas = await this.replicas.count({ where: { storageObjectId: objectId } });
    if (replicas === 0) await this.objects.delete(objectId);
  }

  private async ensureManagedObjectsFolder(accessToken: string, accountId: string, adapter: import('../providers/common/cloud-provider.interface').CloudProviderAdapter): Promise<{ id: string }> {
    const rootChildren = await adapter.listFiles(accessToken, accountId);
    const root = rootChildren.find((file) => file.type === 'folder' && file.name === 'CloudFusion');
    const cloudFusion = root ?? await adapter.createFolder(accessToken, accountId, 'CloudFusion');
    const children = await adapter.listFiles(accessToken, accountId, cloudFusion.id);
    const objects = children.find((file) => file.type === 'folder' && file.name === 'objects');
    return objects ?? adapter.createFolder(accessToken, accountId, 'objects', cloudFusion.id);
  }

  private async updateLogicalState(object: StorageObject): Promise<void> {
    const replicas = await this.replicas.find({ where: { storageObjectId: object.id } });
    const healthy = replicas.filter((replica) => replica.status === StorageReplicaStatus.HEALTHY).length;
    const policy = object.policyId ? await this.policies.findOne({ where: { id: object.policyId } }) : null;
    const required = policy?.replicationFactor ?? 1;
    object.status = healthy >= required ? StorageObjectStatus.AVAILABLE : healthy > 0 ? StorageObjectStatus.DEGRADED : StorageObjectStatus.ERROR;
    await this.objects.save(object);
    const nodeStatus = object.status === StorageObjectStatus.AVAILABLE
      ? VirtualNodeStatus.AVAILABLE
      : object.status === StorageObjectStatus.DEGRADED
        ? VirtualNodeStatus.DEGRADED
        : VirtualNodeStatus.ERROR;
    await this.nodes.update({ storageObjectId: object.id }, { status: nodeStatus });
  }

  private async cleanupStaging(objectId: string, stagingPath: string): Promise<void> {
    const pending = await this.replicas.count({ where: [
      { storageObjectId: objectId, status: StorageReplicaStatus.PENDING },
      { storageObjectId: objectId, status: StorageReplicaStatus.UPLOADING },
      { storageObjectId: objectId, status: StorageReplicaStatus.REPAIRING },
    ] });
    if (pending === 0) await unlink(stagingPath).catch(() => undefined);
  }

  private shouldRetry(error: unknown, job: Job<ReplicationJobPayload>): boolean {
    const normalized = providerHttpError(error, ProviderErrorCode.UPLOAD_FAILED);
    const response = normalized.getResponse();
    const code = typeof response === 'object' && response && 'code' in response ? String(response.code) : '';
    const permanent = [ProviderErrorCode.FILE_NOT_FOUND, ProviderErrorCode.ACCOUNT_NOT_CONNECTED, ProviderErrorCode.PROVIDER_AUTH_EXPIRED, ProviderErrorCode.INSUFFICIENT_STORAGE].includes(code as ProviderErrorCode);
    const maxRetries = this.config.get<number>('transfer.maxRetries') ?? 3;
    return !permanent && job.attemptsMade < maxRetries;
  }
}
