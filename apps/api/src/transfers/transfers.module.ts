import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransferJob } from './entities/transfer-job.entity';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TransferController } from './transfers.controller';
import { TransferService } from './transfers.service';
import { TransferQueueService, TRANSFER_QUEUE } from './transfer-queue.service';
import { TransferProgressService } from './transfer-progress.service';
import { TransferExecutionService } from './transfer-execution.service';
import { TransferWorkerService } from './transfer-worker.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([TransferJob]), ConfigModule, AuditModule],
  controllers: [TransferController],
  providers: [
    {
      provide: TRANSFER_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        TransferQueueService.createQueue(config),
    },
    TransferQueueService,
    TransferProgressService,
    TransferExecutionService,
    TransferWorkerService,
    TransferService,
  ],
  exports: [TransferService, TransferProgressService],
})
export class TransfersModule {}
