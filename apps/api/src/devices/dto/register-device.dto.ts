import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { DevicePlatform } from '../enums/device-platform.enum';

export class RegisterDeviceDto {
  @ApiProperty({ description: 'Random UUID generated once and retained by this installation.' })
  @IsUUID()
  installationId!: string;

  @ApiProperty({ example: 'Sebastian-PC' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiProperty({ enum: DevicePlatform })
  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;

  @ApiProperty({ required: false, example: '0.1.0' })
  @IsString()
  @MaxLength(64)
  clientVersion?: string;
}
