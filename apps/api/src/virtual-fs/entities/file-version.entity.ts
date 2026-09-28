import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('file_versions')
@Index('IDX_file_versions_storage_object', ['storageObjectId'])
@Index('IDX_file_versions_node_created', ['virtualNodeId', 'createdAt'])
@Index('UQ_file_versions_node_number', ['virtualNodeId', 'versionNumber'], {
  unique: true,
  where: '"virtual_node_id" IS NOT NULL',
})
export class FileVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'virtual_node_id', type: 'uuid', nullable: true })
  virtualNodeId!: string | null;

  @Column({ name: 'storage_object_id', type: 'uuid' })
  storageObjectId!: string;

  @Column({ name: 'version_number', type: 'integer' })
  versionNumber!: number;

  @Column({ type: 'bigint' })
  size!: string;

  @Column({ type: 'varchar', length: 128 })
  checksum!: string;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  comment!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
