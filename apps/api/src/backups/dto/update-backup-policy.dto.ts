import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class UpdateBackupPolicyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsUUID()
  destinationAccountId?: string;

  @IsOptional()
  @IsIn(['DAILY', 'WEEKLY', 'MONTHLY'])
  schedule?: 'DAILY' | 'WEEKLY' | 'MONTHLY';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  retentionDays?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
