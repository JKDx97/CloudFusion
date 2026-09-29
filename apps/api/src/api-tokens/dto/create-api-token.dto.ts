import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiTokenScope } from '../api-token-scope';

export class CreateApiTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(Object.values(ApiTokenScope).length)
  @ArrayUnique()
  @IsEnum(ApiTokenScope, { each: true })
  scopes!: ApiTokenScope[];

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
