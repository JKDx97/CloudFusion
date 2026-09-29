import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { User } from '../users/entities/user.entity';
import { WorkspaceInvitation } from './entities/workspace-invitation.entity';
import { WorkspaceMember } from './entities/workspace-member.entity';
import { Workspace } from './entities/workspace.entity';
import { VirtualFsModule } from '../virtual-fs/virtual-fs.module';
import { WorkspaceDriveController } from './workspace-drive.controller';
import { WorkspaceMembershipService } from './workspace-membership.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [TypeOrmModule.forFeature([Workspace, WorkspaceMember, WorkspaceInvitation, User]), AuditModule, VirtualFsModule],
  controllers: [WorkspacesController, WorkspaceDriveController],
  providers: [WorkspacesService, WorkspaceMembershipService],
  exports: [WorkspacesService, WorkspaceMembershipService],
})
export class WorkspacesModule {}
