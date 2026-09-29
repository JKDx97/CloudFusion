import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CloudProvider } from '../../providers/common/cloud-provider.enum';

export const S3_PROVIDERS = [
  CloudProvider.AWS_S3,
  CloudProvider.CLOUDFLARE_R2,
  CloudProvider.WASABI,
  CloudProvider.BACKBLAZE_B2,
  CloudProvider.DIGITALOCEAN_SPACES,
  CloudProvider.ORACLE_OBJECT_STORAGE,
  CloudProvider.IBM_COS,
  CloudProvider.CUSTOM_S3,
];

export class S3TargetBaseDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  bucket!: string;

  @ApiProperty({ example: 'us-east-1' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  region!: string;

  @ApiPropertyOptional({ example: 'https://s3.example.com' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  endpoint?: string;

  @ApiPropertyOptional({ example: 'cloudfusion/objects/' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  prefix?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  forcePathStyle?: boolean;

  @ApiPropertyOptional({ description: 'Use a unique temporary object to check write and delete permissions.' })
  @IsOptional()
  @IsBoolean()
  verifyWrite?: boolean;
}
export class S3TargetInputDto extends S3TargetBaseDto {
  @ApiProperty({ enum: S3_PROVIDERS, description: 'AWS S3 and S3-compatible object storage providers. Supply an endpoint for every provider except AWS_S3.' })
  @IsIn(S3_PROVIDERS)
  provider!: CloudProvider;
}

export class TestS3ConnectionDto extends S3TargetInputDto {}

export class ConnectS3AccountDto extends S3TargetInputDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  accountName?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  accessKeyId!: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  secretAccessKey!: string;

  @ApiPropertyOptional({ format: 'password' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  sessionToken?: string;
}

export class AddS3TargetDto extends S3TargetBaseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;
}

export class TestStoredS3TargetDto {
  @ApiPropertyOptional({ description: 'Only set true to create and delete a tiny, uniquely named temporary object.' })
  @IsOptional()
  @IsBoolean()
  verifyWrite?: boolean;
}
