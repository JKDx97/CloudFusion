import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PeerTransferStatus, PeerTransferTransport } from '../enums/peer-transfer-status.enum';

@Entity('peer_transfer_sessions')
@Index('IDX_peer_transfers_source_status', ['sourceDeviceId', 'status', 'createdAt'])
@Index('IDX_peer_transfers_destination_status', ['destinationDeviceId', 'status', 'createdAt'])
export class PeerTransferSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'source_user_id', type: 'uuid' })
  sourceUserId!: string;

  @Column({ name: 'destination_user_id', type: 'uuid' })
  destinationUserId!: string;

  @Column({ name: 'source_device_id', type: 'uuid' })
  sourceDeviceId!: string;

  @Column({ name: 'destination_device_id', type: 'uuid' })
  destinationDeviceId!: string;

  @Column({ name: 'node_id', type: 'uuid' })
  nodeId!: string;

  @Column({ name: 'version_id', type: 'uuid' })
  versionId!: string;

  @Column({ name: 'content_hash', type: 'varchar', length: 128 })
  contentHash!: string;

  @Column({ name: 'total_bytes', type: 'bigint' })
  totalBytes!: string;

  @Column({ type: 'enum', enum: PeerTransferStatus, enumName: 'peer_transfer_status', default: PeerTransferStatus.AUTHORIZED })
  status!: PeerTransferStatus;

  @Column({ type: 'enum', enum: PeerTransferTransport, enumName: 'peer_transfer_transport', nullable: true })
  transport!: PeerTransferTransport | null;

  @Column({ name: 'bytes_transferred', type: 'bigint', default: 0 })
  bytesTransferred!: string;

  @Column({ name: 'ticket_expires_at', type: 'timestamptz' })
  ticketExpiresAt!: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
