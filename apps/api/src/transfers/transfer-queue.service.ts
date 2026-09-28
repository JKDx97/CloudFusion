import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsOptions, Queue } from 'bullmq';

export const TRANSFER_QUEUE = Symbol('TRANSFER_QUEUE');

export interface TransferQueuePayload {
  transferId: string;
}

@Injectable()
export class TransferQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(TransferQueueService.name);

  constructor(
    @Inject(TRANSFER_QUEUE) private readonly queue: Queue<TransferQueuePayload>,
    private readonly config: ConfigService,
  ) {}

  static createQueue(config: ConfigService): Queue<TransferQueuePayload> {
    const name = config.get<string>('transfer.queueName') ?? 'cloudfusion-transfers';
    return new Queue<TransferQueuePayload>(name, {
      connection: {
        host: config.get<string>('redis.host') ?? 'localhost',
        port: config.get<number>('redis.port') ?? 6379,
        maxRetriesPerRequest: 1,
      },
    });
  }

  async enqueue(transferId: string): Promise<void> {
    const maxRetries = this.config.get<number>('transfer.maxRetries') ?? 3;
    const options: JobsOptions = {
      jobId: `${transferId}:${Date.now()}`,
      attempts: Math.max(1, maxRetries + 1),
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    };
    await this.queue.add('transfer', { transferId }, options);
  }

  async cancel(transferId: string): Promise<void> {
    const jobs = await this.queue.getJobs(['waiting', 'delayed', 'paused']);
    await Promise.all(
      jobs
        .filter((job) => job.data.transferId === transferId)
        .map(async (job) => {
          await job.remove().catch((error) =>
            this.logger.warn(`Could not remove queued transfer ${transferId}: ${String(error)}`),
          );
        }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
