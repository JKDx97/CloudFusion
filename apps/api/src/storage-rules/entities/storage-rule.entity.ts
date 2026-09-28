import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { StorageRuleConditionType } from '../enums/storage-rule-condition.enum';

@Entity('storage_rules')
@Index(['userId', 'priority'])
export class StorageRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ length: 120 })
  name!: string;

  @Column({ type: 'int' })
  priority!: number;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ name: 'condition_type', type: 'enum', enum: StorageRuleConditionType })
  conditionType!: StorageRuleConditionType;

  @Column({ name: 'condition_value', type: 'varchar', length: 255, nullable: true })
  conditionValue!: string | null;

  @Column({ name: 'destination_account_id', type: 'uuid' })
  destinationAccountId!: string;

  @Column({ name: 'destination_folder_id', type: 'varchar', length: 1024, nullable: true })
  destinationFolderId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
