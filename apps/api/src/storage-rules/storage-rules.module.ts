import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CloudAccountsModule } from '../cloud-accounts/cloud-accounts.module';
import { StorageRule } from './entities/storage-rule.entity';
import { StorageRulesController } from './storage-rules.controller';
import { StorageRuleEngine } from './storage-rule-engine.service';
import { StorageRuleService } from './storage-rule.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([StorageRule]), CloudAccountsModule, AuditModule],
  controllers: [StorageRulesController],
  providers: [StorageRuleService, StorageRuleEngine],
  exports: [StorageRuleService, StorageRuleEngine],
})
export class StorageRulesModule {}
