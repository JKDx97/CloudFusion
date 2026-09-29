import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min, MinLength, MaxLength } from 'class-validator';

export class SearchUsersQueryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit = 10;
}
