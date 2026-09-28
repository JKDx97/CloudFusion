import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ConflictStrategy } from '../enums/conflict-strategy.enum';
import { TransferOperation } from '../enums/transfer-operation.enum';

export class CreateTransferDto {
  @ApiProperty()
  @IsUUID()
  sourceAccountId!: string;

  @ApiProperty()
  @IsString()
  sourceFileId!: string;

  @ApiProperty()
  @IsUUID()
  destinationAccountId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  destinationFolderId?: string;

  @ApiProperty({ enum: TransferOperation })
  @IsEnum(TransferOperation)
  operation!: TransferOperation;

  @ApiPropertyOptional({ enum: ConflictStrategy, default: ConflictStrategy.RENAME })
  @IsOptional()
  @IsEnum(ConflictStrategy)
  conflictStrategy?: ConflictStrategy;
}
