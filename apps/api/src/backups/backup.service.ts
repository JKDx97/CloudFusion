import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, In, LessThan, LessThanOrEqual, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { CloudAccountService } from '../cloud-accounts/cloud-account.service';
import { SnapshotsService } from '../snapshots/snapshots.service';
import { BackupQueueService } from './backup-queue.service';
import { CreateBackupPolicyDto } from './dto/create-backup-policy.dto';
import { UpdateBackupPolicyDto } from './dto/update-backup-policy.dto';
import { BackupJob } from './entities/backup-job.entity';
import { BackupPolicy, BackupSchedule } from './entities/backup-policy.entity';
import { BackupCopy } from './entities/backup-copy.entity';
import { CloudAccountStatus } from '../providers/common/cloud-provider.enum';
import { StorageReplica } from '../virtual-fs/entities/storage-replica.entity';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { StorageObject } from '../virtual-fs/entities/storage-object.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { SnapshotEntry } from '../snapshots/entities/snapshot-entry.entity';
import { StorageObjectStatus } from '../virtual-fs/enums/storage-object-status.enum';
import { VirtualNodeStatus } from '../virtual-fs/enums/virtual-node-status.enum';
import { StorageReplicaStatus } from '../virtual-fs/enums/storage-replica-status.enum';
import { BackupVerificationService } from './backup-verification.service';
import { Snapshot } from '../snapshots/entities/snapshot.entity';
import { ProviderErrorCode, providerHttpError } from '../providers/common/provider-error';
import { CloudDownload } from '../providers/common/cloud-file.interface';

@Injectable()
export class BackupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupService.name);
  private timer?: NodeJS.Timeout;
  private scheduling = false;

  constructor(
    @InjectRepository(BackupPolicy) private readonly policies: Repository<BackupPolicy>,
    @InjectRepository(BackupJob) private readonly jobs: Repository<BackupJob>,
    @InjectRepository(BackupCopy) private readonly copies: Repository<BackupCopy>,
    @InjectRepository(StorageReplica) private readonly replicas: Repository<StorageReplica>,
    @InjectRepository(FileVersion) private readonly versions: Repository<FileVersion>,
    @InjectRepository(SnapshotEntry) private readonly entries: Repository<SnapshotEntry>,
    @InjectRepository(StorageObject) private readonly objects: Repository<StorageObject>,
    @InjectRepository(VirtualNode) private readonly nodes: Repository<VirtualNode>,
    @InjectRepository(Snapshot) private readonly snapshotRows: Repository<Snapshot>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly accounts: CloudAccountService,
    private readonly snapshots: SnapshotsService,
    private readonly queue: BackupQueueService,
    private readonly verification: BackupVerificationService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const seconds = Math.max(10, this.config.get<number>('dataProtection.backupScheduleIntervalSeconds') ?? 30);
    this.timer = setInterval(() => void this.scheduleDue().catch((error) => this.logger.warn(`Backup scheduler pass failed: ${String(error)}`)), seconds * 1000);
    void this.scheduleDue().catch((error) => this.logger.warn(`Initial backup scheduler pass failed: ${String(error)}`));
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async listPolicies(userId: string): Promise<BackupPolicy[]> {
    return this.policies.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  async createPolicy(userId: string, dto: CreateBackupPolicyDto): Promise<BackupPolicy> {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Backup policy name is required');
    const destination = await this.accounts.getOwnedAccount(userId, dto.destinationAccountId);
    if (destination.status !== CloudAccountStatus.CONNECTED) throw new BadRequestException('Backup destination must be connected');
    const policy = this.policies.create({
      userId,
      name,
      destinationAccountId: destination.id,
      schedule: dto.schedule ?? 'DAILY',
      retentionDays: dto.retentionDays ?? 30,
      enabled: dto.enabled ?? true,
      scope: 'DRIVE',
      mode: 'SNAPSHOT_BACKUP',
      nextRunAt: null,
    });
    policy.nextRunAt = policy.enabled ? this.nextRun(policy.schedule) : null;
    const saved = await this.policies.save(policy);
    await this.audit.record(userId, 'BACKUP_POLICY_CREATED', 'BackupPolicy', saved.id, { schedule: saved.schedule, retentionDays: saved.retentionDays });
    return saved;
  }

  async updatePolicy(userId: string, id: string, dto: UpdateBackupPolicyDto): Promise<BackupPolicy> {
    const policy = await this.requirePolicy(userId, id);
    if (dto.destinationAccountId) {
      const destination = await this.accounts.getOwnedAccount(userId, dto.destinationAccountId);
      if (destination.status !== CloudAccountStatus.CONNECTED) throw new BadRequestException('Backup destination must be connected');
      policy.destinationAccountId = destination.id;
    }
    if (dto.name != null) {
      policy.name = dto.name.trim();
      if (!policy.name) throw new BadRequestException('Backup policy name is required');
    }
    if (dto.schedule) policy.schedule = dto.schedule;
    if (dto.retentionDays != null) policy.retentionDays = dto.retentionDays;
    if (dto.enabled != null) policy.enabled = dto.enabled;
    policy.nextRunAt = policy.enabled ? this.nextRun(policy.schedule) : null;
    await this.audit.record(userId, 'BACKUP_POLICY_UPDATED', 'BackupPolicy', id, { enabled: policy.enabled, schedule: policy.schedule });
    return this.policies.save(policy);
  }

  async deletePolicy(userId: string, id: string): Promise<{ deleted: true }> {
    const policy = await this.requirePolicy(userId, id);
    await this.policies.delete({ id, userId });
    await this.audit.record(userId, 'BACKUP_POLICY_DELETED', 'BackupPolicy', id);
    return { deleted: true };
  }

  async runPolicy(userId: string, policyId: string): Promise<BackupJob> {
    const policy = await this.requirePolicy(userId, policyId);
    await this.accounts.getAuthorizedAccount(userId, policy.destinationAccountId);
    return this.createAndEnqueue(userId, policy.id, policy.destinationAccountId);
  }

  async listJobs(userId: string): Promise<BackupJob[]> {
    return this.jobs.find({ where: { userId }, order: { createdAt: 'DESC' }, take: 100 });
  }

  async getJob(userId: string, id: string): Promise<BackupJob & { verifiedObjects: number }> {
    const job = await this.jobs.findOne({ where: { id, userId } });
    if (!job) throw new NotFoundException('Backup not found');
    const verifiedObjects = await this.copies.count({ where: { backupJobId: job.id } });
    return Object.assign(job, { verifiedObjects });
  }

  async restore(userId: string, id: string) {
    const job = await this.jobs.findOne({ where: { id, userId } });
    if (!job || !job.snapshotId) throw new NotFoundException('Backup not found');
    if (job.status !== 'COMPLETED') throw new BadRequestException('Only a verified backup can be restored');
    const copies = await this.copies.find({ where: { backupJobId: id } });
    for (const copy of copies) {
      await this.verification.verify(userId, copy);
      const existing = await this.replicas.find({ where: { storageObjectId: copy.storageObjectId, status: StorageReplicaStatus.HEALTHY } });
      let accessible = false;
      for (const replica of existing) {
        try { await this.accounts.getAuthorizedAccount(userId, replica.cloudAccountId); accessible = true; break; }
        catch { /* a healthy row is not useful if its cloud account cannot be authorized */ }
      }
      if (accessible) continue;
      const object = await this.objects.findOne({ where: { id: copy.storageObjectId, userId } });
      if (!object) throw new NotFoundException('Backed up content metadata no longer exists');
      const destination = await this.accounts.getAuthorizedAccount(userId, copy.destinationAccountId);
      const folder = await this.ensureManagedObjectsFolder(destination.accessToken, destination.account.id, destination.adapter);
      const backupStream = await destination.adapter.downloadFile(destination.accessToken, destination.account.id, copy.remoteFileId);
      const uploaded = await destination.adapter.uploadFile(destination.accessToken, destination.account.id, {
        stream: backupStream.stream,
        name: object.storageKey.split('/').pop() ?? `${object.id}.bin`,
        mimeType: object.mimeType ?? 'application/octet-stream',
        size: Number(object.encryptedSize ?? copy.size),
        parentId: folder.id,
      });
      try {
        const verification = await this.verification.verify(userId, {
          destinationAccountId: destination.account.id,
          remoteFileId: uploaded.id,
          size: String(uploaded.size ?? object.encryptedSize ?? copy.size),
          encryptedChecksum: copy.encryptedChecksum,
        } as BackupCopy);
        if (verification.bytes !== Number(object.encryptedSize ?? copy.size)) throw new BadRequestException('Restored object verification failed');
        await this.replicas.save(this.replicas.create({
          storageObjectId: object.id,
          cloudAccountId: destination.account.id,
          provider: destination.account.provider,
          remoteFileId: uploaded.id,
          remoteParentId: folder.id,
          status: StorageReplicaStatus.HEALTHY,
          size: String(uploaded.size ?? object.encryptedSize ?? copy.size),
          checksum: copy.encryptedChecksum,
          lastVerifiedAt: new Date(),
          lastError: null,
          attempts: 0,
        }));
        object.status = StorageObjectStatus.AVAILABLE;
        object.lifecycleStatus = 'ACTIVE';
        object.gcAfter = null;
        await this.objects.save(object);
        await this.nodes.update({ storageObjectId: object.id }, { status: VirtualNodeStatus.AVAILABLE });
      } catch (error) {
        await destination.adapter.deleteItem(destination.accessToken, destination.account.id, uploaded.id).catch(() => undefined);
        throw error;
      }
    }
    await this.audit.record(userId, 'BACKUP_RESTORE_STARTED', 'BackupJob', id, { snapshotId: job.snapshotId });
    return this.snapshots.queueSnapshotRestore(userId, job.snapshotId);
  }

  async processJob(backupJobId: string, attemptsMade = 0, maxAttempts = 1): Promise<void> {
    const job = await this.jobs.findOne({ where: { id: backupJobId } });
    if (!job || job.status === 'COMPLETED') return;
    job.status = job.snapshotId ? 'RUNNING' : 'PREPARING';
    job.startedAt ??= new Date();
    job.errors = [];
    const alreadyCopied = await this.copies.find({ where: { backupJobId: job.id } });
    job.itemsProcessed = alreadyCopied.length;
    job.bytesProcessed = String(alreadyCopied.reduce((sum, copy) => sum + Number(copy.size), 0));
    await this.jobs.save(job);
    try {
      await this.accounts.getAuthorizedAccount(job.userId, job.destinationAccountId);
      if (!job.snapshotId) {
        const snapshot = await this.snapshots.create(job.userId, {
          name: `Backup ${job.createdAt.toISOString()}`,
          description: `Snapshot protegida generada por el backup ${job.id}`,
          isImmutable: true,
        });
        job.snapshotId = snapshot.id;
        job.status = 'RUNNING';
        await this.jobs.save(job);
      }
      let offset = 0;
      const pageSize = 200;
      const errors: Array<{ entryId: string; message: string }> = [];
      job.status = 'VERIFYING';
      await this.jobs.save(job);
      while (true) {
        const entries = await this.entries.find({ where: { snapshotId: job.snapshotId }, order: { id: 'ASC' }, skip: offset, take: pageSize });
        if (!entries.length) break;
        offset += entries.length;
        for (const entry of entries) {
          if (!entry.fileVersionId) continue;
          const version = await this.versions.findOne({ where: { id: entry.fileVersionId } });
          if (!version) { errors.push({ entryId: entry.id, message: 'La versión referenciada ya no existe.' }); continue; }
          const exists = await this.copies.findOne({ where: { backupJobId: job.id, storageObjectId: version.storageObjectId } });
          if (exists) continue;
          try {
            const copy = await this.createVerifiedCopy(job, entry.id, version.id, version.storageObjectId);
            job.itemsProcessed += 1;
            job.bytesProcessed = String(Number(job.bytesProcessed) + Number(copy.size));
            await this.jobs.save(job);
          } catch (error) {
            errors.push({ entryId: entry.id, message: this.safeError(error) });
          }
        }
      }
      job.errors = errors;
      job.completedAt = errors.length && attemptsMade + 1 < maxAttempts ? null : new Date();
      job.status = errors.length ? (attemptsMade + 1 < maxAttempts ? 'QUEUED' : 'FAILED') : 'COMPLETED';
      await this.jobs.save(job);
      if (errors.length) throw new Error('BACKUP_FAILED');
      await this.audit.record(job.userId, 'BACKUP_COMPLETED', 'BackupJob', job.id, { itemsProcessed: job.itemsProcessed, bytesProcessed: Number(job.bytesProcessed), verifiedObjects: job.itemsProcessed });
    } catch (error) {
      job.status = attemptsMade + 1 < maxAttempts ? 'QUEUED' : 'FAILED';
      job.completedAt = job.status === 'FAILED' ? new Date() : null;
      job.errors = [...job.errors, { entryId: '', message: this.safeError(error) }];
      await this.jobs.save(job);
      await this.audit.record(job.userId, job.status === 'FAILED' ? 'BACKUP_FAILED' : 'BACKUP_RETRY_SCHEDULED', 'BackupJob', job.id, { reason: this.safeError(error) });
      throw error;
    }
  }

  async scheduleDue(): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      const due = await this.policies.find({ where: { enabled: true, nextRunAt: LessThanOrEqual(new Date()) }, take: 50 });
      for (const candidate of due) {
        const job = await this.dataSource.transaction(async (manager) => {
          const policy = await manager.getRepository(BackupPolicy).createQueryBuilder('policy').setLock('pessimistic_write').where('policy.id = :id', { id: candidate.id }).getOne();
          if (!policy?.enabled || !policy.nextRunAt || policy.nextRunAt > new Date()) return null;
          const created = manager.getRepository(BackupJob).create({
            userId: policy.userId, policyId: policy.id, destinationAccountId: policy.destinationAccountId,
            snapshotId: null, status: 'QUEUED', bytesProcessed: '0', itemsProcessed: 0, errors: [], startedAt: null, completedAt: null,
          });
          policy.nextRunAt = this.nextRun(policy.schedule);
          await manager.getRepository(BackupPolicy).save(policy);
          return manager.getRepository(BackupJob).save(created);
        });
        if (!job) continue;
        try { await this.queue.enqueue(job.id); }
        catch (error) { await this.failEnqueue(job, error); }
      }
      const policies = await this.policies.find({ where: { enabled: true } });
      for (const policy of policies) await this.cleanupExpired(policy);
    } finally { this.scheduling = false; }
  }

  private async createVerifiedCopy(job: BackupJob, entryId: string, versionId: string, objectId: string): Promise<BackupCopy> {
    const object = await this.objects.findOne({ where: { id: objectId, userId: job.userId } });
    if (!object || !object.encryptedChecksum || !object.encryptedSize) throw new Error('BACKUP_SOURCE_METADATA_UNAVAILABLE');
    const destination = await this.accounts.getAuthorizedAccount(job.userId, job.destinationAccountId);
    const folder = await this.ensureBackupFolder(destination.accessToken, destination.account.id, destination.adapter);
    const backupName = `cf-backup-${job.id}-${object.id}.bin`;
    const existingFiles = await destination.adapter.listFiles(destination.accessToken, destination.account.id, folder.id);
    for (const existing of existingFiles.filter((item) => item.type === 'file' && item.name === backupName)) {
      const candidate = this.copies.create({
        backupJobId: job.id, snapshotEntryId: entryId, fileVersionId: versionId, storageObjectId: object.id,
        destinationAccountId: destination.account.id, provider: destination.account.provider, remoteFileId: existing.id,
        size: String(object.encryptedSize), encryptedChecksum: object.encryptedChecksum,
      });
      try {
        const verification = await this.verification.verify(job.userId, candidate);
        if (verification.bytes === Number(object.encryptedSize)) return this.copies.save(candidate);
      } catch { /* remove incomplete leftovers from an interrupted attempt */ }
      await destination.adapter.deleteItem(destination.accessToken, destination.account.id, existing.id).catch(() => undefined);
    }
    const sources = (await this.replicas.find({ where: { storageObjectId: object.id, status: StorageReplicaStatus.HEALTHY } })).filter((replica) => Boolean(replica.remoteFileId));
    let sourceContext: Awaited<ReturnType<CloudAccountService['getAuthorizedAccount']>> | null = null;
    let sourceReplica: StorageReplica | null = null;
    let sourceDownload: CloudDownload | null = null;
    for (const replica of sources) {
      if (replica.cloudAccountId === job.destinationAccountId) continue;
      try {
        const context = await this.accounts.getAuthorizedAccount(job.userId, replica.cloudAccountId);
        const download = await context.adapter.downloadFile(context.accessToken, context.account.id, replica.remoteFileId!);
        sourceContext = context;
        sourceReplica = replica;
        sourceDownload = download;
        break;
      } catch { /* try another connected encrypted source copy */ }
    }
    if (!sourceContext || !sourceReplica?.remoteFileId || !sourceDownload) throw new Error('BACKUP_SOURCE_UNAVAILABLE');
    const uploaded = await destination.adapter.uploadFile(destination.accessToken, destination.account.id, {
      stream: sourceDownload.stream,
      name: backupName,
      mimeType: 'application/octet-stream',
      size: Number(object.encryptedSize),
      parentId: folder.id,
    });
    const copy = this.copies.create({
      backupJobId: job.id, snapshotEntryId: entryId, fileVersionId: versionId, storageObjectId: object.id,
      destinationAccountId: destination.account.id, provider: destination.account.provider, remoteFileId: uploaded.id,
      size: String(uploaded.size ?? object.encryptedSize), encryptedChecksum: object.encryptedChecksum,
    });
    try {
      const verification = await this.verification.verify(job.userId, copy);
      if (verification.bytes !== Number(object.encryptedSize)) throw new Error('BACKUP_VERIFICATION_FAILED');
      return await this.copies.save(copy);
    } catch (error) {
      await destination.adapter.deleteItem(destination.accessToken, destination.account.id, uploaded.id).catch(() => undefined);
      throw error;
    }
  }

  private async ensureBackupFolder(accessToken: string, accountId: string, adapter: import('../providers/common/cloud-provider.interface').CloudProviderAdapter): Promise<{ id: string }> {
    const top = await adapter.listFiles(accessToken, accountId);
    const cloudFusion = top.find((item) => item.type === 'folder' && item.name === 'CloudFusion')
      ?? await adapter.createFolder(accessToken, accountId, 'CloudFusion');
    const contents = await adapter.listFiles(accessToken, accountId, cloudFusion.id);
    const backups = contents.find((item) => item.type === 'folder' && item.name === 'Backups')
      ?? await adapter.createFolder(accessToken, accountId, 'Backups', cloudFusion.id);
    return { id: backups.id };
  }

  private async ensureManagedObjectsFolder(accessToken: string, accountId: string, adapter: import('../providers/common/cloud-provider.interface').CloudProviderAdapter): Promise<{ id: string }> {
    const top = await adapter.listFiles(accessToken, accountId);
    const cloudFusion = top.find((item) => item.type === 'folder' && item.name === 'CloudFusion')
      ?? await adapter.createFolder(accessToken, accountId, 'CloudFusion');
    const contents = await adapter.listFiles(accessToken, accountId, cloudFusion.id);
    const objects = contents.find((item) => item.type === 'folder' && item.name === 'objects')
      ?? await adapter.createFolder(accessToken, accountId, 'objects', cloudFusion.id);
    return { id: objects.id };
  }

  private nextRun(schedule: BackupSchedule): Date {
    const now = new Date();
    if (schedule === 'MONTHLY') {
      const first = new Date(now);
      first.setUTCDate(1);
      first.setUTCHours(3, 0, 0, 0);
      if (first <= now) first.setUTCMonth(first.getUTCMonth() + 1);
      return first;
    }
    const next = new Date();
    next.setUTCHours(3, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
    if (schedule === 'WEEKLY') while (next.getUTCDay() !== 1) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  private async createAndEnqueue(userId: string, policyId: string | null, destinationAccountId: string): Promise<BackupJob> {
    const job = await this.jobs.save(this.jobs.create({ userId, policyId, snapshotId: null, destinationAccountId, status: 'QUEUED', bytesProcessed: '0', itemsProcessed: 0, errors: [], startedAt: null, completedAt: null }));
    await this.audit.record(userId, 'BACKUP_CREATED', 'BackupJob', job.id, { policyId, destinationAccountId });
    try { await this.queue.enqueue(job.id); }
    catch (error) { await this.failEnqueue(job, error); throw new BadRequestException('Backup queue is temporarily unavailable'); }
    return job;
  }

  private async failEnqueue(job: BackupJob, error: unknown): Promise<void> {
    job.status = 'FAILED';
    job.completedAt = new Date();
    job.errors = [...job.errors, { entryId: '', message: 'BACKUP_QUEUE_UNAVAILABLE' }];
    await this.jobs.save(job);
    await this.audit.record(job.userId, 'BACKUP_FAILED', 'BackupJob', job.id, { reason: this.safeError(error) });
  }

  private async cleanupExpired(policy: BackupPolicy): Promise<void> {
    const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);
    const expired = await this.jobs.find({ where: { userId: policy.userId, policyId: policy.id, status: In(['COMPLETED', 'FAILED']), completedAt: LessThan(cutoff) }, take: 20 });
    for (const job of expired) {
      const copies = await this.copies.find({ where: { backupJobId: job.id } });
      let failed = false;
      const contexts = new Map<string, Awaited<ReturnType<CloudAccountService['getAuthorizedAccount']>>>();
      for (const copy of copies) {
        try {
          let context = contexts.get(copy.destinationAccountId);
          if (!context) {
            context = await this.accounts.getAuthorizedAccount(job.userId, copy.destinationAccountId);
            contexts.set(copy.destinationAccountId, context);
          }
          await context.adapter.deleteItem(context.accessToken, context.account.id, copy.remoteFileId);
        } catch (error) {
          const normalized = providerHttpError(error, ProviderErrorCode.DOWNLOAD_FAILED);
          const response = normalized.getResponse() as { code?: string };
          if (response?.code !== ProviderErrorCode.FILE_NOT_FOUND) failed = true;
        }
      }
      if (failed) {
        job.status = 'FAILED';
        if (!job.errors.some((item) => item.message === 'BACKUP_RETENTION_DELETE_FAILED')) job.errors = [...job.errors, { entryId: '', message: 'BACKUP_RETENTION_DELETE_FAILED' }];
        await this.jobs.save(job);
        await this.audit.record(job.userId, 'BACKUP_FAILED', 'BackupJob', job.id, { reason: 'BACKUP_RETENTION_DELETE_FAILED' });
        continue;
      }
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(BackupJob).delete({ id: job.id, userId: job.userId });
        if (job.snapshotId) await manager.getRepository(Snapshot).delete({ id: job.snapshotId, userId: job.userId });
      });
      await this.audit.record(job.userId, 'BACKUP_EXPIRED', 'BackupJob', job.id, { retentionDays: policy.retentionDays });
    }
  }

  private async requirePolicy(userId: string, id: string): Promise<BackupPolicy> {
    const policy = await this.policies.findOne({ where: { id, userId } });
    if (!policy) throw new NotFoundException('Backup policy not found');
    return policy;
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    return /BACKUP_[A-Z_]+/.test(message) ? message : 'BACKUP_FAILED';
  }
}
