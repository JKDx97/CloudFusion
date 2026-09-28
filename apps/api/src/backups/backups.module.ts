import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { CloudAccountsModule } from '../cloud-accounts/cloud-accounts.module';
import { SnapshotsModule } from '../snapshots/snapshots.module';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { StorageObject } from '../virtual-fs/entities/storage-object.entity';
import { StorageReplica } from '../virtual-fs/entities/storage-replica.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { SnapshotEntry } from '../snapshots/entities/snapshot-entry.entity';
import { Snapshot } from '../snapshots/entities/snapshot.entity';
import { BackupCopy } from './entities/backup-copy.entity';
import { BackupJob } from './entities/backup-job.entity';
import { BackupPolicy } from './entities/backup-policy.entity';
import { BackupQueueService, BACKUP_QUEUE } from './backup-queue.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupService } from './backup.service';
import { BackupWorkerService } from './backup-worker.service';
import { BackupsController } from './backups.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([BackupPolicy, BackupJob, BackupCopy, FileVersion, Snapshot, SnapshotEntry, StorageObject, StorageReplica, VirtualNode]),
    ConfigModule,
    CloudAccountsModule,
    SnapshotsModule,
    AuditModule,
  ],
  controllers: [BackupsController],
  providers: [
    {
      provide: BACKUP_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => BackupQueueService.createQueue(config),
    },
    BackupQueueService,
    BackupVerificationService,
    BackupService,
    BackupWorkerService,
  ],
  exports: [BackupService],
})
export class BackupsModule {}
