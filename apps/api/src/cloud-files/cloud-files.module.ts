import { Module } from '@nestjs/common';
import { CloudAccountsModule } from '../cloud-accounts/cloud-accounts.module';
import { CloudFilesController } from './cloud-files.controller';
import { CloudFilesService } from './cloud-files.service';

@Module({
  imports: [CloudAccountsModule],
  controllers: [CloudFilesController],
  providers: [CloudFilesService],
})
export class CloudFilesModule {}
