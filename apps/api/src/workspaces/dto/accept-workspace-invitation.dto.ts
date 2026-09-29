import { IsString, Length } from 'class-validator';

export class AcceptWorkspaceInvitationDto {
  @IsString()
  @Length(43, 43)
  token!: string;
}
