import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type BackupJobStatus = 'QUEUED' | 'PREPARING' | 'RUNNING' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

@Entity('backup_jobs')
@Index('IDX_backup_jobs_user_created', ['userId', 'createdAt'])
@Index('IDX_backup_jobs_policy_created', ['policyId', 'createdAt'])
export class BackupJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'policy_id', type: 'uuid', nullable: true })
  policyId!: string | null;

  @Column({ name: 'snapshot_id', type: 'uuid', nullable: true })
  snapshotId!: string | null;

  @Column({ name: 'destination_account_id', type: 'uuid' })
  destinationAccountId!: string;

  @Column({ type: 'varchar', length: 32, default: 'QUEUED' })
  status!: BackupJobStatus;

  @Column({ name: 'bytes_processed', type: 'bigint', default: 0 })
  bytesProcessed!: string;

  @Column({ name: 'items_processed', type: 'integer', default: 0 })
  itemsProcessed!: number;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  errors!: Array<{ entryId: string; message: string }>;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
