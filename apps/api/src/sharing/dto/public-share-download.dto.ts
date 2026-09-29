import { IsOptional, IsString, MaxLength } from 'class-validator';

export class PublicShareDownloadDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;
}
