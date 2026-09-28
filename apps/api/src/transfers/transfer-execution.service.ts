import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Readable } from 'node:stream';
import { Repository } from 'typeorm';
import { CloudAccountService, AuthorizedCloudAccount } from '../cloud-accounts/cloud-account.service';
import { CloudFile } from '../providers/common/cloud-file.interface';
import { ProviderErrorCode, ProviderException, providerHttpError } from '../providers/common/provider-error';
import { CloudProviderAdapter, ProviderUploadInput } from '../providers/common/cloud-provider.interface';
import { TransferJob } from './entities/transfer-job.entity';
import { ConflictStrategy } from './enums/conflict-strategy.enum';
import { TransferStatus } from './enums/transfer-status.enum';
import { TransferQueuePayload } from './transfer-queue.service';
import { TransferProgressService } from './transfer-progress.service';

export class TransferCancelledError extends Error {
  constructor() {
    super('Transfer was cancelled');
  }
}

interface TransferNode {
  file: CloudFile;
  parentId: string;
  relativePath: string;
}

@Injectable()
export class TransferExecutionService {
  constructor(
    @InjectRepository(TransferJob)
    private readonly repository: Repository<TransferJob>,
    private readonly accounts: CloudAccountService,
    private readonly progress: TransferProgressService,
    private readonly config: ConfigService,
  ) {}

  async execute(transferId: string, queueJob: Job<TransferQueuePayload>): Promise<void> {
    const job = await this.repository.findOne({ where: { id: transferId } });
    if (!job) return;
    await this.ensureNotCancelled(job.id);
    job.status = TransferStatus.PREPARING;
    job.startedAt ??= new Date();
    job.attemptCount += 1;
    job.errorCode = null;
    job.errorMessage = null;
    await this.save(job);

    const source = await this.accounts.getAuthorizedAccount(job.userId, job.sourceAccountId);
    const destination = await this.accounts.getAuthorizedAccount(job.userId, job.destinationAccountId);
    const sourceFile = await this.runProvider(
      () => source.adapter.getFile(source.accessToken, job.sourceAccountId, job.sourceFileId),
      ProviderErrorCode.FILE_NOT_FOUND,
    );
    let destinationFolderId = job.destinationFolderId ?? undefined;
    if (destinationFolderId) {
      const destinationFolder = await this.runProvider(
        () => destination.adapter.getFile(destination.accessToken, job.destinationAccountId, destinationFolderId),
        ProviderErrorCode.FILE_NOT_FOUND,
      );
      if (destinationFolder.type !== 'folder') throw new ProviderException(ProviderErrorCode.FILE_NOT_FOUND, 404);
    }

    job.status = TransferStatus.TRANSFERRING;
    await this.save(job);

    if (sourceFile.type === 'folder') {
      const nodes = await this.collectTree(source, sourceFile.id);
      const totalBytes = nodes.reduce((sum, node) => sum + (node.file.size ?? 0), 0);
      job.fileSize = String(totalBytes);
      await this.save(job);
      const destinationRoot = await this.createDestinationFolder(
        destination,
        job,
        sourceFile.name,
        destinationFolderId,
      );
      if (destinationRoot) {
        const folderMap = new Map<string, string>([[sourceFile.id, destinationRoot.id]]);
        for (const node of nodes) {
          await this.ensureNotCancelled(job.id);
          const parent = folderMap.get(node.parentId);
          if (!parent) throw new ProviderException(ProviderErrorCode.UPLOAD_FAILED, 502);
          if (node.file.type === 'folder') {
            const created = await this.createDestinationFolder(destination, job, node.file.name, parent);
            if (created) folderMap.set(node.file.id, created.id);
          } else {
            await this.copyFile(job, source, destination, node.file, parent, totalBytes, queueJob);
          }
        }
        if (job.operation === 'MOVE') await this.deleteSource(job, source, sourceFile.id);
      }
    } else {
      const totalBytes = sourceFile.size ?? 0;
      job.fileSize = sourceFile.size == null ? null : String(sourceFile.size);
      await this.save(job);
      const destinationFile = await this.copyFile(
        job,
        source,
        destination,
        sourceFile,
        destinationFolderId,
        totalBytes,
        queueJob,
      );
      if (destinationFile && job.operation === 'MOVE') {
        await this.deleteSource(job, source, sourceFile.id);
      }
    }

    const latest = await this.repository.findOne({ where: { id: job.id } });
    if (!latest || latest.status === TransferStatus.CANCELLED || latest.cancelRequested) {
      throw new TransferCancelledError();
    }
    latest.status = TransferStatus.COMPLETED;
    latest.progress = 100;
    latest.completedAt = new Date();
    latest.errorCode = null;
    latest.errorMessage = null;
    await this.save(latest);
  }

  private async collectTree(source: AuthorizedCloudAccount, folderId: string, prefix = ''): Promise<TransferNode[]> {
    const children = await this.runProvider(
      () => source.adapter.listFiles(source.accessToken, source.account.id, folderId),
      ProviderErrorCode.PROVIDER_UNAVAILABLE,
    );
    const nodes: TransferNode[] = [];
    for (const file of children) {
      const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
      nodes.push({ file, parentId: folderId, relativePath });
      if (file.type === 'folder') {
        nodes.push(...(await this.collectTree(source, file.id, relativePath)));
      }
    }
    return nodes;
  }

  private async createDestinationFolder(
    destination: AuthorizedCloudAccount,
    job: TransferJob,
    name: string,
    parentId?: string,
  ): Promise<CloudFile | null> {
    const resolvedName = await this.resolveName(destination, job, name, parentId, 'folder');
    if (!resolvedName) return null;
    return this.runProvider(
      () => destination.adapter.createFolder(destination.accessToken, destination.account.id, resolvedName, parentId),
      ProviderErrorCode.UPLOAD_FAILED,
    );
  }

  private async copyFile(
    job: TransferJob,
    source: AuthorizedCloudAccount,
    destination: AuthorizedCloudAccount,
    sourceFile: CloudFile,
    parentId: string | undefined,
    totalBytes: number,
    queueJob: Job<TransferQueuePayload>,
  ): Promise<CloudFile | null> {
    const name = await this.resolveName(destination, job, sourceFile.name, parentId, 'file');
    if (!name) return null;
    const download = await this.runProvider(
      () => source.adapter.downloadFile(source.accessToken, source.account.id, sourceFile.id),
      ProviderErrorCode.DOWNLOAD_FAILED,
    );
    const progressStart = Number(job.bytesTransferred ?? 0);
    let transferred = 0;
    let lastReport = 0;
    let reportChain = Promise.resolve();
    const interval = this.config.get<number>('transfer.progressIntervalMs') ?? 1000;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < interval) return;
      lastReport = now;
      reportChain = reportChain.then(async () => {
        const current = await this.repository.findOne({ where: { id: job.id } });
        if (!current || current.cancelRequested || current.status === TransferStatus.CANCELLED) {
          throw new TransferCancelledError();
        }
        const bytes = progressStart + transferred;
        current.bytesTransferred = String(bytes);
        current.progress = totalBytes > 0 ? Math.min(99, Math.floor((bytes / totalBytes) * 100)) : 0;
        await this.repository.save(current);
        await queueJob.updateProgress(current.progress);
        this.progress.emit(current);
      });
    };
    download.stream.on('data', (chunk: Buffer | string) => {
      transferred += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      report();
    });
    const input: ProviderUploadInput = {
      stream: download.stream,
      name,
      mimeType: download.mimeType ?? sourceFile.mimeType,
      size: download.size ?? sourceFile.size,
      parentId,
    };
    try {
      await this.runProvider(
        () => destination.adapter.uploadFile(destination.accessToken, destination.account.id, input),
        ProviderErrorCode.UPLOAD_FAILED,
      );
      report(true);
      await reportChain;
      const destinationFile = await this.runProvider(
        async () => {
          const files = await destination.adapter.listFiles(destination.accessToken, destination.account.id, parentId);
          return files.find((file) => file.name === name && file.type === 'file') ?? null;
        },
        ProviderErrorCode.UPLOAD_FAILED,
      );
      if (!destinationFile) throw new ProviderException(ProviderErrorCode.UPLOAD_FAILED, 502);
      if (sourceFile.size != null && destinationFile.size != null && sourceFile.size !== destinationFile.size) {
        throw new ProviderException(ProviderErrorCode.UPLOAD_FAILED, 502);
      }
      return destinationFile;
    } finally {
      await reportChain;
    }
  }

  private async resolveName(
    destination: AuthorizedCloudAccount,
    job: TransferJob,
    name: string,
    parentId: string | undefined,
    type: 'file' | 'folder',
  ): Promise<string | null> {
    const files = await this.runProvider(
      () => destination.adapter.listFiles(destination.accessToken, destination.account.id, parentId),
      ProviderErrorCode.PROVIDER_UNAVAILABLE,
    );
    const existing = files.find((file) => file.name === name && file.type === type);
    if (!existing) return name;
    if (job.conflictStrategy === ConflictStrategy.SKIP) return null;
    if (job.conflictStrategy === ConflictStrategy.OVERWRITE) {
      await this.runProvider(
        () => destination.adapter.deleteItem(destination.accessToken, destination.account.id, existing.id),
        ProviderErrorCode.UPLOAD_FAILED,
      );
      return name;
    }
    const dot = type === 'file' ? name.lastIndexOf('.') : -1;
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let index = 1;
    let candidate = `${stem} (${index})${extension}`;
    while (files.some((file) => file.name === candidate)) {
      index += 1;
      candidate = `${stem} (${index})${extension}`;
    }
    return candidate;
  }

  private async deleteSource(job: TransferJob, source: AuthorizedCloudAccount, fileId: string): Promise<void> {
    try {
      await this.runProvider(
        () => source.adapter.deleteItem(source.accessToken, source.account.id, fileId),
        ProviderErrorCode.MOVE_SOURCE_DELETE_FAILED,
      );
    } catch (error) {
      if (error instanceof ProviderException && error.getResponse()) {
        throw error;
      }
      throw new ProviderException(ProviderErrorCode.MOVE_SOURCE_DELETE_FAILED, 502);
    }
  }

  private async ensureNotCancelled(id: string): Promise<void> {
    const job = await this.repository.findOne({ where: { id } });
    if (!job || job.cancelRequested || job.status === TransferStatus.CANCELLED) {
      throw new TransferCancelledError();
    }
  }

  private async save(job: TransferJob): Promise<void> {
    const saved = await this.repository.save(job);
    this.progress.emit(saved);
  }

  private async runProvider<T>(operation: () => Promise<T>, fallback: ProviderErrorCode): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ProviderException) throw error;
      throw providerHttpError(error, fallback);
    }
  }
}
