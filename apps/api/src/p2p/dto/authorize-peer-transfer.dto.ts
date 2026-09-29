import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AuthorizePeerTransferDto {
  @ApiProperty({ format: 'uuid', description: 'Registered source device which advertises the exact file version.' })
  @IsUUID()
  sourceDeviceId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  nodeId!: string;

  @ApiProperty({ format: 'uuid', description: 'Exact immutable file version; a file name alone is not sufficient.' })
  @IsUUID()
  versionId!: string;
}
