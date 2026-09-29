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

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([UserDevice, VirtualNode, FileVersion, DeviceFileAvailability, PeerTransferSession]),
    DevicesModule,
    PermissionsModule,
    AuditModule,
  ],
  controllers: [P2pController],
  providers: [P2pService],
  exports: [P2pService],
})
export class P2pModule {}
