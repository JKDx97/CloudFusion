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

  @Column({ name: 'checksum_algorithm', type: 'varchar', length: 32, default: 'SHA-256' })
  checksumAlgorithm!: string;

  @Column({ type: 'enum', enum: StorageObjectStatus, default: StorageObjectStatus.UPLOADING })
  status!: StorageObjectStatus;

  @Column({ name: 'policy_id', type: 'uuid', nullable: true })
  policyId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
