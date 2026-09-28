import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateFolderDto {
  @ApiProperty({ example: 'Documentos' })
  @IsString()
  @Length(1, 255)
  name!: string;

  @ApiPropertyOptional({ description: 'Remote parent folder identifier' })
  @IsOptional()
  @IsString()
  parentId?: string;
}
