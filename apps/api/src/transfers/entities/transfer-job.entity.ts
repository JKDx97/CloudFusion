import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CloudProvider } from '../../providers/common/cloud-provider.enum';
import { ConflictStrategy } from '../enums/conflict-strategy.enum';
import { TransferOperation } from '../enums/transfer-operation.enum';
import { TransferStatus } from '../enums/transfer-status.enum';

@Entity('transfer_jobs')
@Index(['userId', 'createdAt'])
@Index(['userId', 'status'])
export class TransferJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'source_account_id', type: 'uuid' })
  sourceAccountId!: string;

  @Column({ name: 'source_provider', type: 'enum', enum: CloudProvider })
  sourceProvider!: CloudProvider;

  @Column({ name: 'source_file_id', type: 'varchar', length: 1024 })
  sourceFileId!: string;

  @Column({ name: 'destination_account_id', type: 'uuid' })
  destinationAccountId!: string;

  @Column({ name: 'destination_provider', type: 'enum', enum: CloudProvider })
  destinationProvider!: CloudProvider;

  @Column({ name: 'destination_folder_id', type: 'varchar', length: 1024, nullable: true })
  destinationFolderId!: string | null;

  @Column({ type: 'enum', enum: TransferOperation })
  operation!: TransferOperation;

  @Column({ name: 'conflict_strategy', type: 'enum', enum: ConflictStrategy, default: ConflictStrategy.RENAME })
  conflictStrategy!: ConflictStrategy;

  @Column({ name: 'parent_job_id', type: 'uuid', nullable: true })
  parentJobId!: string | null;

  @Column({ name: 'relative_path', type: 'text', nullable: true })
  relativePath!: string | null;

  @Column({ name: 'file_name', type: 'varchar', length: 1024 })
  fileName!: string;

  @Column({ name: 'file_size', type: 'bigint', nullable: true })
  fileSize!: string | null;

  @Column({ type: 'enum', enum: TransferStatus, default: TransferStatus.QUEUED })
  status!: TransferStatus;

  @Column({ type: 'int', default: 0 })
  progress!: number;

  @Column({ name: 'bytes_transferred', type: 'bigint', default: 0 })
  bytesTransferred!: string;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ name: 'error_code', type: 'varchar', length: 100, nullable: true })
  errorCode!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'cancel_requested', type: 'boolean', default: false })
  cancelRequested!: boolean;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
