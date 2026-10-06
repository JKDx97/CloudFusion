import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateP2pPrivacyDto {
  @ApiProperty({ description: 'Account-wide permission for all peer-to-peer discovery and transfers.' })
  @IsBoolean()
  enabled!: boolean;
}
