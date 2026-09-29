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
import { User } from '../../users/entities/user.entity';
import { CloudAccountStatus, CloudProvider } from '../../providers/common/cloud-provider.enum';
import { CloudCredentialType } from './cloud-credential-type.enum';

@Entity('cloud_accounts')
@Index(['userId'])
@Index(['userId', 'provider', 'providerAccountId'], { unique: true })
export class CloudAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, (user) => user.cloudAccounts, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'enum', enum: CloudProvider })
  provider!: CloudProvider;

  @Column({ name: 'provider_account_id', length: 255 })
  providerAccountId!: string;

  @Column({ type: 'varchar', nullable: true, length: 255 })
  email!: string | null;

  @Column({ name: 'display_name', type: 'varchar', nullable: true, length: 255 })
  displayName!: string | null;

  @Column({ name: 'credential_type', type: 'varchar', length: 32, default: CloudCredentialType.OAUTH2 })
  credentialType: CloudCredentialType = CloudCredentialType.OAUTH2;

  @Column({ name: 'credentials_encrypted', type: 'text', nullable: true })
  credentialsEncrypted!: string | null;

  @Column({ name: 'configuration_encrypted', type: 'text', nullable: true })
  configurationEncrypted!: string | null;

  @Column({ name: 'access_token_encrypted', type: 'text' })
  accessTokenEncrypted!: string;

  @Column({ name: 'refresh_token_encrypted', type: 'text', nullable: true })
  refreshTokenEncrypted!: string | null;

  @Column({ name: 'token_expires_at', type: 'timestamptz', nullable: true })
  tokenExpiresAt!: Date | null;

  @Column({ type: 'text', array: true, default: '{}' })
  scopes!: string[];

  @Column({ type: 'enum', enum: CloudAccountStatus, default: CloudAccountStatus.CONNECTED })
  status!: CloudAccountStatus;

  @Column({ name: 'storage_total', type: 'bigint', nullable: true })
  storageTotal!: string | null;

  @Column({ name: 'storage_used', type: 'bigint', nullable: true })
  storageUsed!: string | null;

  @Column({ name: 'last_sync_at', type: 'timestamptz', nullable: true })
  lastSyncAt!: Date | null;

  @Column({ name: 'last_health_check_at', type: 'timestamptz', nullable: true })
  lastHealthCheckAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
