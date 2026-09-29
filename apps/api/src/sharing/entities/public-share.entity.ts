import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum PublicSharePermission {
  VIEW_ONLY = 'VIEW_ONLY',
  DOWNLOAD = 'DOWNLOAD',
}

@Entity('public_shares')
@Index('UQ_public_shares_token_hash', ['tokenHash'], { unique: true })
@Index('IDX_public_shares_owner_created', ['ownerUserId', 'createdAt'])
@Index('IDX_public_shares_node_enabled', ['nodeId', 'enabled'])
export class PublicShare {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @Column({ name: 'node_id', type: 'uuid' })
  nodeId!: string;

  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash!: string;

  @Column({ type: 'enum', enum: PublicSharePermission })
  permission!: PublicSharePermission;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'password_hash', type: 'text', nullable: true, select: false })
  passwordHash!: string | null;

  @Column({ name: 'download_limit', type: 'integer', nullable: true })
  downloadLimit!: number | null;

  @Column({ name: 'download_count', type: 'integer', default: 0 })
  downloadCount!: number;

  @Column({ default: true })
  enabled!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
