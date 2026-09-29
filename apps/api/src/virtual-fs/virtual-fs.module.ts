import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { CloudAccountsModule } from '../cloud-accounts/cloud-accounts.module';
import { StorageObject } from './entities/storage-object.entity';
import { StoragePolicy } from './entities/storage-policy.entity';
import { StorageReplica } from './entities/storage-replica.entity';
import { VirtualNode } from './entities/virtual-node.entity';
import { REPLICATION_QUEUE, ReplicationQueueService } from './replication-queue.service';
import { VirtualDriveController } from './virtual-drive.controller';
import { VirtualDriveService } from './virtual-drive.service';
import { ReplicationWorkerService } from './replication-worker.service';
import { ReplicaHealthService } from './replica-health.service';
import { EncryptionService } from '../data-protection/encryption.service';
import { KeyManagementService } from '../data-protection/key-management.service';
import { KeyRotationService } from '../data-protection/key-rotation.service';
import { FileVersion } from './entities/file-version.entity';
import { SnapshotEntry } from '../snapshots/entities/snapshot-entry.entity';
import { StorageGarbageCollectorService } from './storage-garbage-collector.service';
import { BackupCopy } from '../backups/entities/backup-copy.entity';
import { PermissionsModule } from '../permissions/permissions.module';
import { SharingModule } from '../sharing/sharing.module';
import { PublicShare } from '../sharing/entities/public-share.entity';
import { PublicSharesController } from '../sharing/public-shares.controller';
import { PublicSharesService } from '../sharing/public-shares.service';
import { User } from '../users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([VirtualNode, StorageObject, StorageReplica, StoragePolicy, FileVersion, SnapshotEntry, BackupCopy, PublicShare, User]), ConfigModule, CloudAccountsModule, AuditModule, PermissionsModule, SharingModule],
  controllers: [VirtualDriveController, PublicSharesController],
  providers: [
    {
      provide: REPLICATION_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ReplicationQueueService.createQueue(config),
    },
    ReplicationQueueService,
    VirtualDriveService,
    PublicSharesService,
    ReplicationWorkerService,
    ReplicaHealthService,
    StorageGarbageCollectorService,
    KeyManagementService,
    KeyRotationService,
    EncryptionService,
  ],
  exports: [VirtualDriveService],
})
export class VirtualFsModule {}
