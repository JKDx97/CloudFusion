import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { CloudAccount } from '../../../cloud-accounts/entities/cloud-account.entity';
import { UserDevice } from '../../../devices/entities/user-device.entity';
import { DeviceStorageClass } from '../enums/device-storage-class.enum';
import { DeviceStorageStatus } from '../enums/device-storage-status.enum';

@Entity('storage_targets')
@Index('UQ_storage_targets_account_remote_prefix', ['cloudAccountId', 'remoteIdentifier', 'prefix'], { unique: true })
@Index('IDX_storage_targets_account_enabled', ['cloudAccountId', 'enabled'])
@Index('UQ_storage_targets_device', ['deviceId'], {
  unique: true,
  where: "type = 'DEVICE' AND device_id IS NOT NULL",
})
@Index('IDX_storage_targets_device_status', ['deviceId', 'availabilityStatus'])
export class StorageTarget {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'cloud_account_id', type: 'uuid', nullable: true })
  cloudAccountId!: string | null;

  @ManyToOne(() => CloudAccount, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'cloud_account_id' })
  cloudAccount!: CloudAccount | null;

  @Column({ name: 'device_id', type: 'uuid', nullable: true })
  deviceId!: string | null;

  @ManyToOne(() => UserDevice, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'device_id' })
  device!: UserDevice | null;

  @Column({ type: 'varchar', length: 40 })
  type!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({
    name: 'remote_identifier',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  remoteIdentifier!: string | null;

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

  @Column({ name: 'max_bytes', type: 'bigint', nullable: true })
  maxBytes!: string | null;

  @Column({ name: 'used_bytes', type: 'bigint', default: '0' })
  usedBytes!: string;

  @Column({ name: 'available_bytes', type: 'bigint', default: '0' })
  availableBytes!: string;

  @Column({
    name: 'storage_class',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  storageClass!: DeviceStorageClass | null;

  @Column({
    name: 'availability_status',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  availabilityStatus!: DeviceStorageStatus | null;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
