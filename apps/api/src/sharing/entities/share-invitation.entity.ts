import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ResourceShareRole } from '../../permissions/entities/resource-share.entity';

@Entity('share_invitations')
@Index('IDX_share_invitations_owner_created', ['ownerUserId', 'createdAt'])
@Index('IDX_share_invitations_email_expiry', ['email', 'expiresAt'])
export class ShareInvitation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 255 })
  email!: string;

  @Column({ name: 'node_id', type: 'uuid' })
  nodeId!: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @Column({ type: 'enum', enum: ResourceShareRole, enumName: 'resource_shares_role_enum' })
  role!: ResourceShareRole;

  @Column({ name: 'token_hash', type: 'char', length: 64, unique: true })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
