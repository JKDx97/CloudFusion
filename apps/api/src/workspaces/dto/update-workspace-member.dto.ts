import { IsIn } from 'class-validator';
import { WorkspaceRole } from '../entities/workspace-member.entity';

export class UpdateWorkspaceMemberDto {
  @IsIn([WorkspaceRole.ADMIN, WorkspaceRole.MEMBER, WorkspaceRole.VIEWER])
  role!: WorkspaceRole;
}
