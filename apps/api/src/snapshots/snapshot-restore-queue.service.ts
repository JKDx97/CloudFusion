import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsOptions, Queue } from 'bullmq';

export const SNAPSHOT_RESTORE_QUEUE = Symbol('SNAPSHOT_RESTORE_QUEUE');

export interface SnapshotRestorePayload {
  restoreJobId: string;
}

@Injectable()
export class SnapshotRestoreQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(SnapshotRestoreQueueService.name);

  constructor(
    @Inject(SNAPSHOT_RESTORE_QUEUE) private readonly queue: Queue<SnapshotRestorePayload>,
    private readonly config: ConfigService,
  ) {}

  static createQueue(config: ConfigService): Queue<SnapshotRestorePayload> {
    return new Queue<SnapshotRestorePayload>(config.get<string>('dataProtection.snapshotRestoreQueueName') ?? 'cloudfusion-snapshot-restores', {
      connection: {
        host: config.get<string>('redis.host') ?? 'localhost',
        port: config.get<number>('redis.port') ?? 6379,
        maxRetriesPerRequest: 1,
      },
    });
  }

  async enqueue(restoreJobId: string): Promise<void> {
    const attempts = Math.max(1, (this.config.get<number>('dataProtection.snapshotRestoreMaxRetries') ?? 3) + 1);
    const options: JobsOptions = {
      jobId: restoreJobId,
      attempts,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    };
    await this.queue.add('restore-snapshot', { restoreJobId }, options);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch((error: unknown) => this.logger.warn(`Could not close snapshot restore queue: ${String(error)}`));
  }
}
