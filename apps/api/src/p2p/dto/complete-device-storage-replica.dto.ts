import { IsString, Matches } from 'class-validator';

export class CompleteDeviceStorageReplicaDto {
  @IsString()
  @Matches(/^[a-f\d]{64}$/i)
  contentHash!: string;

  @IsString()
  @Matches(/^(0|[1-9]\d*)$/)
  sizeBytes!: string;
}
