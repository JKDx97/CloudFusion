import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { DevicePlatform } from '../enums/device-platform.enum';

@Entity('user_devices')
@Unique('UQ_user_devices_user_installation', ['userId', 'installationId'])
@Index('IDX_user_devices_user_revoked', ['userId', 'revokedAt'])
@Index('IDX_user_devices_peer_id', ['peerId'], { unique: true, where: 'peer_id IS NOT NULL' })
export class UserDevice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /** Stable, random installation identifier generated and retained by the client. */
  @Column({ name: 'installation_id', type: 'uuid' })
  installationId!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'enum', enum: DevicePlatform, enumName: 'device_platform' })
  platform!: DevicePlatform;

  @Column({ name: 'client_version', type: 'varchar', length: 64, nullable: true })
  clientVersion!: string | null;

  @Column({ name: 'peer_id', type: 'varchar', length: 128, nullable: true })
  peerId!: string | null;

  @Column({ name: 'peer_public_key', type: 'text', nullable: true })
  peerPublicKey!: string | null;

  @Column({ name: 'refresh_token_hash', type: 'text', nullable: true, select: false })
  refreshTokenHash!: string | null;

  @Column({ name: 'p2p_enabled', type: 'boolean', default: false })
  p2pEnabled!: boolean;

  @Column({ name: 'lan_discovery_enabled', type: 'boolean', default: true })
  lanDiscoveryEnabled!: boolean;

  @Column({ name: 'internet_p2p_enabled', type: 'boolean', default: false })
  internetP2pEnabled!: boolean;

  @Column({ name: 'relay_allowed', type: 'boolean', default: true })
  relayAllowed!: boolean;

  @Column({ name: 'serve_local_files', type: 'boolean', default: false })
  serveLocalFiles!: boolean;

  @Column({ name: 'storage_contribution_enabled', type: 'boolean', default: false })
  storageContributionEnabled!: boolean;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
