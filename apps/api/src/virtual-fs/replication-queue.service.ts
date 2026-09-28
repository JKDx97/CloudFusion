import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsOptions, Queue } from 'bullmq';

export const REPLICATION_QUEUE = Symbol('REPLICATION_QUEUE');

export interface ReplicationJobPayload {
  replicaId: string;
  stagingPath?: string;
  action?: 'UPLOAD' | 'DELETE';
  rootNodeId?: string;
}

@Injectable()
export class ReplicationQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(ReplicationQueueService.name);

  constructor(
    @Inject(REPLICATION_QUEUE) private readonly queue: Queue<ReplicationJobPayload>,
    private readonly config: ConfigService,
  ) {}

  static createQueue(config: ConfigService): Queue<ReplicationJobPayload> {
    return new Queue<ReplicationJobPayload>(config.get<string>('virtualDrive.queueName') ?? 'cloudfusion-replication', {
      connection: {
        host: config.get<string>('redis.host') ?? 'localhost',
        port: config.get<number>('redis.port') ?? 6379,
        maxRetriesPerRequest: 1,
      },
    });
  }

  async enqueue(payload: ReplicationJobPayload): Promise<void> {
    const maxRetries = this.config.get<number>('transfer.maxRetries') ?? 3;
    const options: JobsOptions = {
      jobId: `${payload.replicaId}:${Date.now()}`,
      attempts: Math.max(1, maxRetries + 1),
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    };
    await this.queue.add('replicate', payload, options);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch((error: unknown) => this.logger.warn(`Could not close replication queue: ${String(error)}`));
  }
}
