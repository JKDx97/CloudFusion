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

@Module({
  imports: [TypeOrmModule.forFeature([VirtualNode, StorageObject, StorageReplica, StoragePolicy]), ConfigModule, CloudAccountsModule, AuditModule],
  controllers: [VirtualDriveController],
  providers: [
    {
      provide: REPLICATION_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ReplicationQueueService.createQueue(config),
    },
    ReplicationQueueService,
    VirtualDriveService,
    ReplicationWorkerService,
    ReplicaHealthService,
    KeyManagementService,
    EncryptionService,
  ],
  exports: [VirtualDriveService],
})
export class VirtualFsModule {}
