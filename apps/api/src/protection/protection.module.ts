import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { BackupJob } from '../backups/entities/backup-job.entity';
import { SnapshotsModule } from '../snapshots/snapshots.module';
import { Snapshot } from '../snapshots/entities/snapshot.entity';
import { StorageObject } from '../virtual-fs/entities/storage-object.entity';
import { StorageReplica } from '../virtual-fs/entities/storage-replica.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { ProtectionAlert } from './entities/protection-alert.entity';
import { ProtectionController } from './protection.controller';
import { ProtectionService } from './protection.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProtectionAlert, AuditLog, VirtualNode, FileVersion, StorageObject, StorageReplica, Snapshot, BackupJob]),
    ConfigModule,
    AuditModule,
    SnapshotsModule,
  ],
  controllers: [ProtectionController],
  providers: [ProtectionService],
  exports: [ProtectionService],
})
export class ProtectionModule {}
