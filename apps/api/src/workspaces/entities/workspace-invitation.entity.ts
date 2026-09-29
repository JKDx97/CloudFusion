import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { WorkspaceRole } from './workspace-member.entity';

@Entity('workspace_invitations')
@Index('IDX_workspace_invitations_workspace_created', ['workspaceId', 'createdAt'])
@Index('UQ_workspace_invitations_pending_email', ['workspaceId', 'email'], {
  unique: true,
  where: '"accepted_at" IS NULL AND "revoked_at" IS NULL',
})
export class WorkspaceInvitation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId!: string;

  @Column({ name: 'inviter_user_id', type: 'uuid' })
  inviterUserId!: string;

  @Column({ length: 255 })
  email!: string;

  @Column({ type: 'enum', enum: WorkspaceRole, enumName: 'workspace_members_role_enum' })
  role!: WorkspaceRole;

  @Column({ name: 'token_hash', type: 'char', length: 64, select: false })
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
