import { IsOptional, IsUUID } from 'class-validator';

export class MoveVirtualNodeDto {
  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}
