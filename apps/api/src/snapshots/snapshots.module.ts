import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { StorageObject } from '../virtual-fs/entities/storage-object.entity';
import { Snapshot } from './entities/snapshot.entity';
import { SnapshotEntry } from './entities/snapshot-entry.entity';
import { SnapshotRestoreJob } from './entities/snapshot-restore-job.entity';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';
import { SnapshotRestoreQueueService, SNAPSHOT_RESTORE_QUEUE } from './snapshot-restore-queue.service';
import { SnapshotRestoreWorkerService } from './snapshot-restore-worker.service';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [TypeOrmModule.forFeature([Snapshot, SnapshotEntry, SnapshotRestoreJob, VirtualNode, FileVersion, StorageObject]), AuditModule, ConfigModule],
  controllers: [SnapshotsController],
  providers: [
    {
      provide: SNAPSHOT_RESTORE_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => SnapshotRestoreQueueService.createQueue(config),
    },
    SnapshotRestoreQueueService,
    SnapshotRestoreWorkerService,
    SnapshotsService,
  ],
  exports: [SnapshotsService],
})
export class SnapshotsModule {}
