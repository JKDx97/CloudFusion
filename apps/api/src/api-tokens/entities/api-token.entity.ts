import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ApiTokenScope } from '../api-token-scope';

@Entity('api_tokens')
@Index('UQ_api_tokens_prefix', ['prefix'], { unique: true })
@Index('IDX_api_tokens_user_created', ['userId', 'createdAt'])
export class ApiToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ name: 'token_hash', type: 'char', length: 64, select: false })
  tokenHash!: string;

  @Column({ type: 'varchar', length: 24 })
  prefix!: string;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  scopes!: ApiTokenScope[];

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
