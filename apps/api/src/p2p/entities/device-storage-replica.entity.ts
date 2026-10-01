import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export enum DeviceStorageReplicaStatus {
  PENDING = 'PENDING',
  DOWNLOADING = 'DOWNLOADING',
  AVAILABLE = 'AVAILABLE',
  OFFLINE = 'OFFLINE',
  CORRUPTED = 'CORRUPTED',
  CANCELLED = 'CANCELLED',
}

@Entity('device_storage_replicas')
@Unique('UQ_device_storage_replica_device_version', ['deviceId', 'nodeId', 'versionId'])
@Index('IDX_device_storage_replicas_device_status', ['deviceId', 'status'])
@Index('IDX_device_storage_replicas_object_status', ['storageObjectId', 'status'])
export class DeviceStorageReplica {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'device_id', type: 'uuid' })
  deviceId!: string;

  @Column({ name: 'node_id', type: 'uuid' })
  nodeId!: string;

  @Column({ name: 'version_id', type: 'uuid' })
  versionId!: string;

  @Column({ name: 'storage_object_id', type: 'uuid' })
  storageObjectId!: string;

  @Column({ name: 'content_hash', type: 'varchar', length: 128 })
  contentHash!: string;

  @Column({ name: 'size_bytes', type: 'bigint' })
  sizeBytes!: string;

  @Column({ type: 'varchar', length: 16, default: DeviceStorageReplicaStatus.PENDING })
  status!: DeviceStorageReplicaStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;

  @Column({ name: 'last_verified_at', type: 'timestamptz', nullable: true })
  lastVerifiedAt!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
