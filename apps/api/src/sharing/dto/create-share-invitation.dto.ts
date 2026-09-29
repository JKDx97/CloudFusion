import { IsEmail, IsEnum, IsUUID } from 'class-validator';
import { ResourceShareRole } from '../../permissions/entities/resource-share.entity';

export class CreateShareInvitationDto {
  @IsUUID()
  nodeId!: string;

  @IsEmail()
  email!: string;

  @IsEnum(ResourceShareRole)
  role!: ResourceShareRole;
}
