import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CloudAccountsModule } from '../cloud-accounts/cloud-accounts.module';
import { StorageRule } from './entities/storage-rule.entity';
import { StorageRulesController } from './storage-rules.controller';
import { StorageRuleEngine } from './storage-rule-engine.service';
import { StorageRuleService } from './storage-rule.service';

@Module({
  imports: [TypeOrmModule.forFeature([StorageRule]), CloudAccountsModule],
  controllers: [StorageRulesController],
  providers: [StorageRuleService, StorageRuleEngine],
  exports: [StorageRuleService, StorageRuleEngine],
})
export class StorageRulesModule {}
