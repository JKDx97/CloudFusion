import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ClaimPeerTransferDto {
  @ApiProperty({ description: 'Short-lived CloudFusion-signed transfer ticket.' })
  @IsString()
  @MinLength(16)
  @MaxLength(8192)
  ticket!: string;
}
