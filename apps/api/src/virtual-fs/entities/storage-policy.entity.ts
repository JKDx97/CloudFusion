import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { StoragePolicyType } from '../enums/storage-policy-type.enum';

@Entity('storage_policies')
@Index('IDX_storage_policies_user', ['userId'])
@Index('UQ_storage_policies_user_name', ['userId', 'name'], { unique: true })
export class StoragePolicy {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ length: 120 })
  name!: string;

  @Column({ type: 'enum', enum: StoragePolicyType })
  type!: StoragePolicyType;

  @Column({ name: 'replication_factor', type: 'int', default: 1 })
  replicationFactor!: number;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
