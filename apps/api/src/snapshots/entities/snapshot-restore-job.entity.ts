import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type SnapshotRestoreJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

@Entity('snapshot_restore_jobs')
@Index('IDX_snapshot_restore_jobs_user_created', ['userId', 'createdAt'])
@Index('IDX_snapshot_restore_jobs_snapshot_status', ['snapshotId', 'status'])
export class SnapshotRestoreJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'snapshot_id', type: 'uuid' })
  snapshotId!: string;

  @Column({ type: 'varchar', length: 24, default: 'QUEUED' })
  status!: SnapshotRestoreJobStatus;

  @Column({ name: 'total_entries', type: 'integer', default: 0 })
  totalEntries!: number;

  @Column({ name: 'processed_entries', type: 'integer', default: 0 })
  processedEntries!: number;

  @Column({ name: 'entry_mappings', type: 'jsonb', default: () => "'{}'::jsonb" })
  entryMappings!: Record<string, string>;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  errors!: Array<{ entryId: string; message: string }>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
