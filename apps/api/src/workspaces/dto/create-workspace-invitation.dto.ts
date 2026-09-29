import { IsEmail, IsIn } from 'class-validator';
import { WorkspaceRole } from '../entities/workspace-member.entity';

export class CreateWorkspaceInvitationDto {
  @IsEmail()
  email!: string;

  @IsIn([WorkspaceRole.ADMIN, WorkspaceRole.MEMBER, WorkspaceRole.VIEWER])
  role!: WorkspaceRole;
}
