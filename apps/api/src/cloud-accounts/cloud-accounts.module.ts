import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CloudAccountsController } from './cloud-accounts.controller';
import { CloudAccountService } from './cloud-account.service';
import { CloudAccount } from './entities/cloud-account.entity';
import { OAuthStateService } from './services/oauth-state.service';
import { TokenEncryptionService } from './services/token-encryption.service';
import { GoogleDriveModule } from '../providers/google-drive/google-drive.module';
import { OneDriveModule } from '../providers/onedrive/onedrive.module';
import { CloudProviderResolver } from '../providers/common/cloud-provider-resolver.service';

@Module({
  imports: [TypeOrmModule.forFeature([CloudAccount]), GoogleDriveModule, OneDriveModule],
  controllers: [CloudAccountsController],
  providers: [CloudAccountService, TokenEncryptionService, OAuthStateService, CloudProviderResolver],
  exports: [CloudAccountService, TokenEncryptionService, CloudProviderResolver],
})
export class CloudAccountsModule {}
