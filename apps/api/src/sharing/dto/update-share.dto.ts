import { IsEnum } from 'class-validator';
import { ResourceShareRole } from '../../permissions/entities/resource-share.entity';

export class UpdateShareDto {
  @IsEnum(ResourceShareRole)
  role!: ResourceShareRole;
}
