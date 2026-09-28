import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type BackupSchedule = 'DAILY' | 'WEEKLY' | 'MONTHLY';

@Entity('backup_policies')
@Index('IDX_backup_policies_user_enabled_due', ['userId', 'enabled', 'nextRunAt'])
export class BackupPolicy {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ length: 120 })
  name!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'varchar', length: 24, default: 'DRIVE' })
  scope!: string;

  @Column({ type: 'varchar', length: 24, default: 'DAILY' })
  schedule!: BackupSchedule;

  @Column({ name: 'retention_days', type: 'integer', default: 30 })
  retentionDays!: number;

  @Column({ name: 'destination_account_id', type: 'uuid' })
  destinationAccountId!: string;

  @Column({ type: 'varchar', length: 32, default: 'SNAPSHOT_BACKUP' })
  mode!: string;

  @Column({ name: 'next_run_at', type: 'timestamptz', nullable: true })
  nextRunAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
