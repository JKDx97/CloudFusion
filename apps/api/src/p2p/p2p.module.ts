import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { DevicesModule } from '../devices/devices.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { DeviceFileAvailability } from './entities/device-file-availability.entity';
import { PeerTransferSession } from './entities/peer-transfer-session.entity';
import { P2pController } from './p2p.controller';
import { P2pService } from './p2p.service';
import { UserDevice } from '../devices/entities/user-device.entity';
import { StorageTarget } from '../providers/object-storage/entities/storage-target.entity';
import { StorageReplica } from '../virtual-fs/entities/storage-replica.entity';
import { StorageObject } from '../virtual-fs/entities/storage-object.entity';
import { DeviceStorageReplica } from './entities/device-storage-replica.entity';
import { DeviceStorageReplicaService } from './device-storage-replica.service';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([UserDevice, StorageTarget, StorageObject, StorageReplica, DeviceStorageReplica, VirtualNode, FileVersion, DeviceFileAvailability, PeerTransferSession]),
    DevicesModule,
    PermissionsModule,
    AuditModule,
  ],
  controllers: [P2pController],
  providers: [P2pService, DeviceStorageReplicaService],
  exports: [P2pService],
})
export class P2pModule {}
