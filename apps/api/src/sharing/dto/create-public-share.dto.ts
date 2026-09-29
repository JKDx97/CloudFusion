import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PublicSharePermission } from '../entities/public-share.entity';

export enum PublicShareExpiry {
  ONE_DAY = '1_DAY',
  SEVEN_DAYS = '7_DAYS',
  THIRTY_DAYS = '30_DAYS',
  NEVER = 'NEVER',
  CUSTOM = 'CUSTOM',
}

export class CreatePublicShareDto {
  @IsUUID()
  nodeId!: string;

  @IsEnum(PublicSharePermission)
  permission!: PublicSharePermission;

  @IsOptional()
  @IsEnum(PublicShareExpiry)
  expiry?: PublicShareExpiry;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  downloadLimit?: number;
}
