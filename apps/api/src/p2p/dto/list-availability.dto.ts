import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ListAvailabilityDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  nodeId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  versionId!: string;
}
