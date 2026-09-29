import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export enum ResourceShareRole {
  VIEWER = 'VIEWER',
  EDITOR = 'EDITOR',
}

export enum ResourceShareStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

@Entity('resource_shares')
@Unique('UQ_resource_shares_node_recipient', ['nodeId', 'sharedWithUserId'])
@Index('IDX_resource_shares_owner', ['ownerUserId', 'createdAt'])
@Index('IDX_resource_shares_recipient', ['sharedWithUserId', 'status', 'createdAt'])
@Index('IDX_resource_shares_node_status', ['nodeId', 'status'])
export class ResourceShare {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @Column({ name: 'node_id', type: 'uuid' })
  nodeId!: string;

  @Column({ name: 'shared_with_user_id', type: 'uuid' })
  sharedWithUserId!: string;

  @Column({ type: 'enum', enum: ResourceShareRole })
  role!: ResourceShareRole;

  @Column({ type: 'enum', enum: ResourceShareStatus, default: ResourceShareStatus.ACTIVE })
  status!: ResourceShareStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
