import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { RegisterDeviceDto } from '../../devices/dto/register-device.dto';

export class PairDeviceDto {
  @ApiProperty({ description: 'One-time 128-bit pairing code; hyphens are optional.' })
  @IsString()
  @MinLength(32)
  @MaxLength(39)
  @Matches(/^[a-f\d-]+$/i)
  code!: string;

  @ApiProperty({ type: RegisterDeviceDto })
  @ValidateNested()
  @Type(() => RegisterDeviceDto)
  device!: RegisterDeviceDto;
}
