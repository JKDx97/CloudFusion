import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class RenameItemDto {
  @ApiProperty({ example: 'Informe final.pdf' })
  @IsString()
  @Length(1, 255)
  name!: string;
}
