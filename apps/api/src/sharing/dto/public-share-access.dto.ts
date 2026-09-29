import { IsOptional, IsString, MaxLength } from 'class-validator';

export class PublicShareAccessDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;
}
