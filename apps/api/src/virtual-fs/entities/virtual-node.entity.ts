import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { VirtualNodeStatus } from '../enums/virtual-node-status.enum';
import { VirtualNodeType } from '../enums/virtual-node-type.enum';

@Entity('virtual_nodes')
@Index('IDX_virtual_nodes_user_parent', ['userId', 'parentId'])
@Index('IDX_virtual_nodes_user_recent', ['userId', 'lastAccessedAt'])
@Index('UQ_virtual_nodes_user_parent_name_active', ['userId', 'parentId', 'name'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
export class VirtualNode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId!: string | null;

  @Column({ length: 255 })
  name!: string;

  @Column({ type: 'enum', enum: VirtualNodeType })
  type!: VirtualNodeType;

  @Column({ name: 'mime_type', type: 'varchar', length: 255, nullable: true })
  mimeType!: string | null;

  @Column({ type: 'bigint', nullable: true })
  size!: string | null;

  @Column({ type: 'enum', enum: VirtualNodeStatus, default: VirtualNodeStatus.AVAILABLE })
  status!: VirtualNodeStatus;

  @Column({ name: 'storage_object_id', type: 'uuid', nullable: true })
  storageObjectId!: string | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({ name: 'previous_parent_id', type: 'uuid', nullable: true })
  previousParentId!: string | null;

  @Column({ name: 'is_root', type: 'boolean', default: false })
  isRoot!: boolean;

  @Column({ name: 'is_favorite', type: 'boolean', default: false })
  isFavorite!: boolean;

  @Column({ name: 'last_accessed_at', type: 'timestamptz', nullable: true })
  lastAccessedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
