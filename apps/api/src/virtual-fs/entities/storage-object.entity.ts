import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { StorageObjectStatus } from '../enums/storage-object-status.enum';

@Entity('storage_objects')
@Index('IDX_storage_objects_user', ['userId'])
@Index('UQ_storage_objects_storage_key', ['storageKey'], { unique: true })
export class StorageObject {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'storage_key', type: 'varchar', length: 255 })
  storageKey!: string;

  @Column({ type: 'bigint' })
  size!: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 255, nullable: true })
  mimeType!: string | null;

  @Column({ type: 'varchar', length: 128 })
  checksum!: string;

  @Column({ name: 'encrypted_checksum', type: 'varchar', length: 128, nullable: true })
  encryptedChecksum!: string | null;

  @Column({ name: 'checksum_algorithm', type: 'varchar', length: 32, default: 'SHA-256' })
  checksumAlgorithm!: string;

  @Column({ type: 'enum', enum: StorageObjectStatus, default: StorageObjectStatus.UPLOADING })
  status!: StorageObjectStatus;

  @Column({ name: 'encrypted_size', type: 'bigint', nullable: true })
  encryptedSize!: string | null;

  @Column({ name: 'encryption_algorithm', type: 'varchar', length: 32, nullable: true })
  encryptionAlgorithm!: string | null;

  @Column({ name: 'encrypted_dek', type: 'text', nullable: true, select: false })
  encryptedDek!: string | null;

  @Column({ name: 'dek_iv', type: 'varchar', length: 64, nullable: true, select: false })
  dekIv!: string | null;

  @Column({ name: 'dek_auth_tag', type: 'varchar', length: 64, nullable: true, select: false })
  dekAuthTag!: string | null;

  @Column({ name: 'content_iv', type: 'varchar', length: 64, nullable: true, select: false })
  contentIv!: string | null;

  @Column({ name: 'content_auth_tag', type: 'varchar', length: 64, nullable: true, select: false })
  contentAuthTag!: string | null;

  @Column({ name: 'key_version', type: 'int', nullable: true })
  keyVersion!: number | null;

  @Column({ name: 'reference_count', type: 'int', default: 1 })
  referenceCount!: number;

  @Column({ name: 'lifecycle_status', type: 'varchar', length: 24, default: 'ACTIVE' })
  lifecycleStatus!: 'ACTIVE' | 'ORPHANED' | 'GC_PENDING' | 'DELETING' | 'DELETED' | 'ERROR';

  @Column({ name: 'gc_after', type: 'timestamptz', nullable: true })
  gcAfter!: Date | null;

  @Column({ name: 'policy_id', type: 'uuid', nullable: true })
  policyId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
