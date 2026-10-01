import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class ReportDeviceStorageDto {
  @ApiProperty({
    description: 'Current bytes used by CloudFusion on this device. Sent as a decimal string.',
    example: '5242880',
  })
  @IsString()
  @Matches(/^(0|[1-9]\d{0,18})$/)
  usedBytes!: string;
}
