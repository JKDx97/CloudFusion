import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import { BackupQueuePayload } from './backup-queue.service';
import { BackupService } from './backup.service';

@Injectable()
export class BackupWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupWorkerService.name);
  private worker?: Worker<BackupQueuePayload>;

  constructor(private readonly config: ConfigService, private readonly backups: BackupService) {}

  onModuleInit(): void {
    if (this.config.get<boolean>('dataProtection.backupWorkerEnabled') === false) return;
    this.worker = new Worker<BackupQueuePayload>(
      this.config.get<string>('dataProtection.backupQueueName') ?? 'cloudfusion-backups',
      (job: Job<BackupQueuePayload>) => this.backups.processJob(job.data.backupJobId, job.attemptsMade, job.opts.attempts ?? 1),
      {
        connection: {
          host: this.config.get<string>('redis.host') ?? 'localhost',
          port: this.config.get<number>('redis.port') ?? 6379,
          maxRetriesPerRequest: null,
        },
        concurrency: Math.max(1, this.config.get<number>('dataProtection.backupWorkerConcurrency') ?? 2),
      },
    );
    this.worker.on('error', (error) => this.logger.warn(`Backup worker error: ${error.message}`));
  }

  async onModuleDestroy(): Promise<void> { await this.worker?.close(); }
}
