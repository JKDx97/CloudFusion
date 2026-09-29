import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PeerTransferStatus, PeerTransferTransport } from '../enums/peer-transfer-status.enum';

export class UpdatePeerTransferStateDto {
  @ApiProperty({ enum: PeerTransferStatus })
  @IsEnum(PeerTransferStatus)
  status!: PeerTransferStatus;

  @ApiPropertyOptional({ enum: PeerTransferTransport })
  @IsOptional()
  @IsEnum(PeerTransferTransport)
  transport?: PeerTransferTransport;

  @ApiPropertyOptional({ description: 'Monotonic byte count as a decimal string.' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,20}$/)
  @MaxLength(20)
  bytesTransferred?: string;
}
