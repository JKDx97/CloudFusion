import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CloudAccount } from '../../../cloud-accounts/entities/cloud-account.entity';

@Entity('storage_targets')
@Index('UQ_storage_targets_account_remote_prefix', ['cloudAccountId', 'remoteIdentifier', 'prefix'], { unique: true })
@Index('IDX_storage_targets_account_enabled', ['cloudAccountId', 'enabled'])
export class StorageTarget {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'cloud_account_id', type: 'uuid' })
  cloudAccountId!: string;

  @ManyToOne(() => CloudAccount, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cloud_account_id' })
  cloudAccount!: CloudAccount;

  @Column({ type: 'varchar', length: 40 })
  type!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ name: 'remote_identifier', type: 'varchar', length: 255 })
  remoteIdentifier!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  region!: string | null;

  @Column({ type: 'text', nullable: true })
  endpoint!: string | null;

  @Column({ type: 'text', default: '' })
  prefix!: string;

  @Column({ name: 'force_path_style', type: 'boolean', default: false })
  forcePathStyle!: boolean;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
