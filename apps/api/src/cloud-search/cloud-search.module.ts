import { Module } from '@nestjs/common';
import { CloudAccountsModule } from '../cloud-accounts/cloud-accounts.module';
import { CloudSearchController } from './cloud-search.controller';
import { CloudSearchService } from './cloud-search.service';

@Module({
  imports: [CloudAccountsModule],
  controllers: [CloudSearchController],
  providers: [CloudSearchService],
})
export class CloudSearchModule {}
