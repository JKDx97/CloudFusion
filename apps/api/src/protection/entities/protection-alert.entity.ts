import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('protection_alerts')
@Index('IDX_protection_alerts_user_created', ['userId', 'createdAt'])
@Index('IDX_protection_alerts_user_kind_status', ['userId', 'kind', 'status'])
export class ProtectionAlert {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 48 })
  kind!: string;

  @Column({ type: 'varchar', length: 24, default: 'WARNING' })
  status!: 'WARNING' | 'RESOLVED';

  @Column({ name: 'event_count', type: 'integer' })
  eventCount!: number;

  @Column({ name: 'window_seconds', type: 'integer' })
  windowSeconds!: number;

  @Column({ name: 'observed_from', type: 'timestamptz' })
  observedFrom!: Date;

  @Column({ name: 'observed_until', type: 'timestamptz' })
  observedUntil!: Date;

  @Column({ name: 'emergency_snapshot_id', type: 'uuid', nullable: true })
  emergencySnapshotId!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  details!: Record<string, unknown>;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
