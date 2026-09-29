import { IsString, Length } from 'class-validator';

export class AcceptShareInvitationDto {
  @IsString()
  @Length(32, 128)
  token!: string;
}
