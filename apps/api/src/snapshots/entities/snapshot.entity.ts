import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type SnapshotStatus = 'CREATING' | 'AVAILABLE' | 'FAILED' | 'DELETING';

@Entity('snapshots')
@Index('IDX_snapshots_user_created', ['userId', 'createdAt'])
export class Snapshot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 24, default: 'CREATING' })
  status!: SnapshotStatus;

  @Column({ name: 'is_immutable', type: 'boolean', default: false })
  isImmutable!: boolean;

  @Column({ name: 'node_count', type: 'integer', default: 0 })
  nodeCount!: number;

  @Column({ name: 'logical_size', type: 'bigint', default: 0 })
  logicalSize!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
