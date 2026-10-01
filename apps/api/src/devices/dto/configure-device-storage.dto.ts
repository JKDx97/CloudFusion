import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { DeviceStorageClass } from '../../providers/object-storage/enums/device-storage-class.enum';

export class ConfigureDeviceStorageDto {
  @ApiPropertyOptional({
    description: 'Whether this device opts in to contributing disk capacity.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Maximum contribution in bytes, represented as a decimal string to preserve 64-bit precision.',
    example: '10737418240',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d{0,18}$/)
  maxBytes?: string;

  @ApiPropertyOptional({
    enum: DeviceStorageClass,
    default: DeviceStorageClass.VOLATILE,
  })
  @IsOptional()
  @IsEnum(DeviceStorageClass)
  storageClass?: DeviceStorageClass;
}
