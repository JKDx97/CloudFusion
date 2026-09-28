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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
