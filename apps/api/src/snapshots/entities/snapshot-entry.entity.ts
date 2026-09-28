import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('snapshot_entries')
@Index('IDX_snapshot_entries_snapshot_parent', ['snapshotId', 'parentSnapshotEntryId'])
@Index('IDX_snapshot_entries_file_version', ['fileVersionId'])
export class SnapshotEntry {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'snapshot_id', type: 'uuid' })
  snapshotId!: string;

  @Column({ name: 'virtual_node_id', type: 'uuid', nullable: true })
  virtualNodeId!: string | null;

  @Column({ name: 'parent_snapshot_entry_id', type: 'uuid', nullable: true })
  parentSnapshotEntryId!: string | null;

  @Column({ name: 'file_version_id', type: 'uuid', nullable: true })
  fileVersionId!: string | null;

  @Column({ length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: 'FILE' | 'FOLDER';

  @Column({ name: 'is_root', type: 'boolean', default: false })
  isRoot!: boolean;

  @Column({ name: 'mime_type', type: 'varchar', length: 255, nullable: true })
  mimeType!: string | null;

  @Column({ type: 'bigint', nullable: true })
  size!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
