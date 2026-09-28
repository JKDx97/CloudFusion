import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Worker } from 'bullmq';
import { Repository } from 'typeorm';
import { ProviderErrorCode, ProviderException } from '../providers/common/provider-error';
import { TransferJob } from './entities/transfer-job.entity';
import { TransferStatus } from './enums/transfer-status.enum';
import { TransferExecutionService, TransferCancelledError } from './transfer-execution.service';
import { TransferQueuePayload } from './transfer-queue.service';
import { TransferProgressService } from './transfer-progress.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class TransferWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TransferWorkerService.name);
  private worker?: Worker<TransferQueuePayload>;

  constructor(
    @InjectRepository(TransferJob)
    private readonly repository: Repository<TransferJob>,
    private readonly config: ConfigService,
    private readonly execution: TransferExecutionService,
    private readonly progress: TransferProgressService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get<boolean>('transfer.workerEnabled')) return;
    const queueName = this.config.get<string>('transfer.queueName') ?? 'cloudfusion-transfers';
    this.worker = new Worker<TransferQueuePayload>(
      queueName,
      (job) => this.process(job),
      {
        connection: {
          host: this.config.get<string>('redis.host') ?? 'localhost',
          port: this.config.get<number>('redis.port') ?? 6379,
          maxRetriesPerRequest: null,
        },
        concurrency: Math.max(1, this.config.get<number>('transfer.workerConcurrency') ?? 3),
      },
    );
    this.worker.on('error', (error) => this.logger.warn(`Transfer worker error: ${error.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(queueJob: Job<TransferQueuePayload>): Promise<void> {
    const transfer = await this.repository.findOne({ where: { id: queueJob.data.transferId } });
    if (!transfer || transfer.status === TransferStatus.CANCELLED) return;
    try {
      await this.execution.execute(transfer.id, queueJob);
      const completed = await this.repository.findOne({ where: { id: transfer.id } });
      if (completed?.status === TransferStatus.COMPLETED) {
        await this.audit.record(completed.userId, 'TRANSFER_COMPLETED', 'TransferJob', completed.id, {
          operation: completed.operation,
          bytesTransferred: Number(completed.bytesTransferred ?? 0),
        });
      }
    } catch (error) {
      const current = await this.repository.findOne({ where: { id: transfer.id } });
      if (!current) return;
      if (error instanceof TransferCancelledError || current.cancelRequested || current.status === TransferStatus.CANCELLED) {
        current.status = TransferStatus.CANCELLED;
        current.completedAt = new Date();
        await this.save(current);
        await this.audit.record(current.userId, 'TRANSFER_CANCELLED', 'TransferJob', current.id, {});
        return;
      }
      const { code, message } = this.errorDetails(error);
      const maxRetries = this.config.get<number>('transfer.maxRetries') ?? 3;
      const retryable = this.isRetryable(code, error);
      if (retryable && queueJob.attemptsMade < maxRetries) {
        current.status = TransferStatus.RETRYING;
        current.errorCode = code;
        current.errorMessage = message;
        await this.save(current);
        throw error;
      }
      current.status = TransferStatus.FAILED;
      current.errorCode = code;
      current.errorMessage = message;
      current.completedAt = new Date();
      await this.save(current);
      await this.audit.record(current.userId, 'TRANSFER_FAILED', 'TransferJob', current.id, { errorCode: code });
    }
  }

  private async save(job: TransferJob): Promise<void> {
    const saved = await this.repository.save(job);
    this.progress.emit(saved);
  }

  private isRetryable(code: string, error: unknown): boolean {
    if ([
      ProviderErrorCode.FILE_NOT_FOUND,
      ProviderErrorCode.ACCOUNT_NOT_CONNECTED,
      ProviderErrorCode.PROVIDER_AUTH_EXPIRED,
      ProviderErrorCode.INSUFFICIENT_STORAGE,
      ProviderErrorCode.MOVE_SOURCE_DELETE_FAILED,
      'NO_SUITABLE_STORAGE_PROVIDER',
    ].includes(code as ProviderErrorCode)) return false;
    if (code === ProviderErrorCode.PROVIDER_RATE_LIMITED || code === ProviderErrorCode.PROVIDER_UNAVAILABLE) return true;
    const status = error instanceof ProviderException ? error.getStatus() : undefined;
    return status == null || status >= 500;
  }

  private errorDetails(error: unknown): { code: string; message: string } {
    if (error instanceof ProviderException) {
      const response = error.getResponse();
      if (typeof response === 'object' && response && 'code' in response) {
        const body = response as { code?: string; message?: string };
        return { code: body.code ?? 'TRANSFER_FAILED', message: body.message ?? 'Transfer failed' };
      }
    }
    return { code: 'TRANSFER_FAILED', message: error instanceof Error ? error.message : 'Transfer failed' };
  }
}
