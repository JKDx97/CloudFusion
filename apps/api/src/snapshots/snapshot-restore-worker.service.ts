import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import { SnapshotsService } from './snapshots.service';
import { SnapshotRestorePayload } from './snapshot-restore-queue.service';

@Injectable()
export class SnapshotRestoreWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SnapshotRestoreWorkerService.name);
  private worker?: Worker<SnapshotRestorePayload>;

  constructor(private readonly config: ConfigService, private readonly snapshots: SnapshotsService) {}

  onModuleInit(): void {
    if (this.config.get<boolean>('dataProtection.snapshotRestoreWorkerEnabled') === false) return;
    this.worker = new Worker<SnapshotRestorePayload>(
      this.config.get<string>('dataProtection.snapshotRestoreQueueName') ?? 'cloudfusion-snapshot-restores',
      (job: Job<SnapshotRestorePayload>) => this.snapshots.processRestoreJob(job.data.restoreJobId),
      {
        connection: {
          host: this.config.get<string>('redis.host') ?? 'localhost',
          port: this.config.get<number>('redis.port') ?? 6379,
          maxRetriesPerRequest: null,
        },
        concurrency: Math.max(1, this.config.get<number>('dataProtection.snapshotRestoreWorkerConcurrency') ?? 1),
      },
    );
    this.worker.on('error', (error) => this.logger.warn(`Snapshot restore worker error: ${error.message}`));
    const maxAttempts = Math.max(1, (this.config.get<number>('dataProtection.snapshotRestoreMaxRetries') ?? 3) + 1);
    this.worker.on('failed', (job, error) => {
      if (job && job.attemptsMade >= maxAttempts) {
        void this.snapshots.markRestoreJobFailed(job.data.restoreJobId, error).catch((failure) => {
          this.logger.warn(`Could not mark snapshot restore job failed: ${String(failure)}`);
        });
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
