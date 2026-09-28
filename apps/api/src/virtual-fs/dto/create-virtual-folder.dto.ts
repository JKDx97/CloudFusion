import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateVirtualFolderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}
