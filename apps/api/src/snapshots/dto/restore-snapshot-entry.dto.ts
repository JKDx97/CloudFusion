import { IsIn, IsOptional, IsUUID } from 'class-validator';

export type SnapshotRestoreStrategy = 'RESTORE_RENAME' | 'RESTORE_OVERWRITE' | 'RESTORE_SKIP';

export class RestoreSnapshotEntryDto {
  @IsOptional()
  @IsIn(['RESTORE_RENAME', 'RESTORE_OVERWRITE', 'RESTORE_SKIP'])
  strategy?: SnapshotRestoreStrategy;

  @IsOptional()
  @IsUUID()
  targetParentId?: string;
}
