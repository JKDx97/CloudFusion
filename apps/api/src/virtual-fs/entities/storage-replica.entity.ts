import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CloudProvider } from '../../providers/common/cloud-provider.enum';
import { StorageReplicaStatus } from '../enums/storage-replica-status.enum';

@Entity('storage_replicas')
@Index('IDX_storage_replicas_object_status', ['storageObjectId', 'status'])
@Index('IDX_storage_replicas_account', ['cloudAccountId'])
export class StorageReplica {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'storage_object_id', type: 'uuid' })
  storageObjectId!: string;

  @Column({ name: 'cloud_account_id', type: 'uuid' })
  cloudAccountId!: string;

  @Column({ type: 'enum', enum: CloudProvider })
  provider!: CloudProvider;

  @Column({ name: 'remote_file_id', type: 'varchar', length: 1024, nullable: true })
  remoteFileId!: string | null;

  @Column({ name: 'remote_parent_id', type: 'varchar', length: 1024, nullable: true })
  remoteParentId!: string | null;

  @Column({ type: 'enum', enum: StorageReplicaStatus, default: StorageReplicaStatus.PENDING })
  status!: StorageReplicaStatus;

  @Column({ type: 'bigint', nullable: true })
  size!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  checksum!: string | null;

  @Column({ name: 'last_verified_at', type: 'timestamptz', nullable: true })
  lastVerifiedAt!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
