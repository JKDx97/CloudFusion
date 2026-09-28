import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { CloudProvider } from '../../providers/common/cloud-provider.enum';

@Entity('backup_copies')
@Index('UQ_backup_copies_job_object', ['backupJobId', 'storageObjectId'], { unique: true })
@Index('IDX_backup_copies_file_version', ['fileVersionId'])
@Index('IDX_backup_copies_storage_object', ['storageObjectId'])
export class BackupCopy {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'backup_job_id', type: 'uuid' })
  backupJobId!: string;

  @Column({ name: 'snapshot_entry_id', type: 'uuid' })
  snapshotEntryId!: string;

  @Column({ name: 'file_version_id', type: 'uuid' })
  fileVersionId!: string;

  @Column({ name: 'storage_object_id', type: 'uuid' })
  storageObjectId!: string;

  @Column({ name: 'destination_account_id', type: 'uuid' })
  destinationAccountId!: string;

  @Column({ type: 'enum', enum: CloudProvider, enumName: 'cloud_accounts_provider_enum' })
  provider!: CloudProvider;

  @Column({ name: 'remote_file_id', type: 'varchar', length: 1024 })
  remoteFileId!: string;

  @Column({ type: 'bigint' })
  size!: string;

  @Column({ name: 'encrypted_checksum', type: 'varchar', length: 128 })
  encryptedChecksum!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
