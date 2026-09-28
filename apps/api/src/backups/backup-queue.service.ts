import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsOptions, Queue } from 'bullmq';

export const BACKUP_QUEUE = Symbol('BACKUP_QUEUE');

export interface BackupQueuePayload { backupJobId: string }

@Injectable()
export class BackupQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(BackupQueueService.name);

  constructor(@Inject(BACKUP_QUEUE) private readonly queue: Queue<BackupQueuePayload>, private readonly config: ConfigService) {}

  static createQueue(config: ConfigService): Queue<BackupQueuePayload> {
    return new Queue<BackupQueuePayload>(config.get<string>('dataProtection.backupQueueName') ?? 'cloudfusion-backups', {
      connection: {
        host: config.get<string>('redis.host') ?? 'localhost',
        port: config.get<number>('redis.port') ?? 6379,
        maxRetriesPerRequest: 1,
      },
    });
  }

  async enqueue(backupJobId: string): Promise<void> {
    const attempts = Math.max(1, (this.config.get<number>('dataProtection.backupMaxRetries') ?? 3) + 1);
    const options: JobsOptions = {
      jobId: `backup-${backupJobId}`,
      attempts,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    };
    await this.queue.add('snapshot-backup', { backupJobId }, options);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch((error: unknown) => this.logger.warn(`Could not close backup queue: ${String(error)}`));
  }
}
