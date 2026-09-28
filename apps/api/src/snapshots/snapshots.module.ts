import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { StorageObject } from '../virtual-fs/entities/storage-object.entity';
import { Snapshot } from './entities/snapshot.entity';
import { SnapshotEntry } from './entities/snapshot-entry.entity';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';

@Module({
  imports: [TypeOrmModule.forFeature([Snapshot, SnapshotEntry, VirtualNode, FileVersion, StorageObject]), AuditModule],
  controllers: [SnapshotsController],
  providers: [SnapshotsService],
  exports: [SnapshotsService],
})
export class SnapshotsModule {}
