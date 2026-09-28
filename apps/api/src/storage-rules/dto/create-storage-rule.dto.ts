import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { StorageRuleConditionType } from '../enums/storage-rule-condition.enum';

export class CreateStorageRuleDto {
  @ApiProperty()
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  priority!: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ enum: StorageRuleConditionType })
  @IsEnum(StorageRuleConditionType)
  conditionType!: StorageRuleConditionType;

  @ApiPropertyOptional({ description: 'Comma-separated extensions, MIME pattern, or byte threshold' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  conditionValue?: string;

  @ApiProperty()
  @IsUUID()
  destinationAccountId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  destinationFolderId?: string;
}
