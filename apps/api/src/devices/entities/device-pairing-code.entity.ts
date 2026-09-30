import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('device_pairing_codes')
@Index('IDX_device_pairing_codes_hash', ['codeHash'], { unique: true })
@Index('IDX_device_pairing_codes_expiry', ['expiresAt'])
export class DevicePairingCode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'code_hash', type: 'character varying', length: 64, select: false })
  codeHash!: string;

  @Column({ name: 'expires_at', type: 'timestamp with time zone' })
  expiresAt!: Date;

  @Column({ name: 'consumed_at', type: 'timestamp with time zone', nullable: true })
  consumedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamp with time zone', default: () => 'now()' })
  createdAt!: Date;
}
