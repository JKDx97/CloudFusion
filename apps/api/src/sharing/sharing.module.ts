import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { ResourceShare } from '../permissions/entities/resource-share.entity';
import { User } from '../users/entities/user.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { ShareInvitation } from './entities/share-invitation.entity';
import { SharingController } from './sharing.controller';
import { SharingService } from './sharing.service';

@Module({
  imports: [TypeOrmModule.forFeature([ResourceShare, ShareInvitation, VirtualNode, User]), PermissionsModule, AuditModule],
  controllers: [SharingController],
  providers: [SharingService],
})
export class SharingModule {}
