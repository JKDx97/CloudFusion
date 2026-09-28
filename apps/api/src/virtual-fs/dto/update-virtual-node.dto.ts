import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateVirtualNodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;
}
