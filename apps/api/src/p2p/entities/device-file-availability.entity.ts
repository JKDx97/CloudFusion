import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export enum DeviceFileAvailabilityStatus {
  AVAILABLE = 'AVAILABLE',
  OFFLINE = 'OFFLINE',
  CORRUPTED = 'CORRUPTED',
}

@Entity('device_file_availability')
@Unique('UQ_device_file_availability_device_version', ['deviceId', 'nodeId', 'versionId'])
@Index('IDX_device_file_availability_version_expiry', ['nodeId', 'versionId', 'expiresAt'])
export class DeviceFileAvailability {
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

  @Column({ name: 'content_hash', type: 'varchar', length: 128 })
  contentHash!: string;

  @Column({ name: 'size_bytes', type: 'bigint' })
  sizeBytes!: string;

  @Column({ type: 'varchar', length: 16, default: DeviceFileAvailabilityStatus.AVAILABLE })
  status!: DeviceFileAvailabilityStatus;

  /** Client-asserted cache presence, useful only while this short lease is fresh. */
  @Column({ name: 'last_verified_at', type: 'timestamptz' })
  lastVerifiedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
