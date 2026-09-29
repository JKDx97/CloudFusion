import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class AdvertiseAvailabilityDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  nodeId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  versionId!: string;

  @ApiProperty({ description: 'SHA-256 hex digest computed from the local cached file.' })
  @IsString()
  @Matches(/^[a-fA-F\d]{64}$/)
  contentHash!: string;

  @ApiProperty({ description: 'Local cached file size in bytes as a decimal string.' })
  @IsString()
  @Matches(/^(0|[1-9]\d{0,18})$/)
  @MinLength(1)
  @MaxLength(19)
  sizeBytes!: string;
}
