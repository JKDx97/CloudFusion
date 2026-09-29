import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CloudAccountsController } from './cloud-accounts.controller';
import { CloudAccountService } from './cloud-account.service';
import { CloudAccount } from './entities/cloud-account.entity';
import { OAuthStateService } from './services/oauth-state.service';
import { TokenEncryptionService } from './services/token-encryption.service';
import { GoogleDriveModule } from '../providers/google-drive/google-drive.module';
import { OneDriveModule } from '../providers/onedrive/onedrive.module';
import { DropboxModule } from '../providers/dropbox/dropbox.module';
import { BoxModule } from '../providers/box/box.module';
import { CloudProviderResolver } from '../providers/common/cloud-provider-resolver.service';
import { ProviderRegistryService } from '../providers/common/provider-registry.service';
import { ProvidersController } from '../providers/providers.controller';
import { S3CloudAccountsController } from './s3-cloud-accounts.controller';
import { S3CloudAccountService } from './s3-cloud-account.service';
import { StorageTarget } from '../providers/object-storage/entities/storage-target.entity';
import { S3CompatibleProviderFactory } from '../providers/s3/s3-compatible-provider.factory';
import { AccountImpactService } from './account-impact.service';
import { StorageReplica } from '../virtual-fs/entities/storage-replica.entity';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { SnapshotEntry } from '../snapshots/entities/snapshot-entry.entity';
import { BackupPolicy } from '../backups/entities/backup-policy.entity';
import { BackupCopy } from '../backups/entities/backup-copy.entity';
import { DropboxOAuthController } from './dropbox-oauth.controller';
import { BoxOAuthController } from './box-oauth.controller';
import { S3CloudProviderAdapterFactory } from '../providers/s3/s3-cloud-provider-adapter.factory';

@Module({
  imports: [TypeOrmModule.forFeature([CloudAccount, StorageTarget, StorageReplica, FileVersion, SnapshotEntry, BackupPolicy, BackupCopy]), GoogleDriveModule, OneDriveModule, DropboxModule, BoxModule],
  controllers: [CloudAccountsController, ProvidersController, S3CloudAccountsController, DropboxOAuthController, BoxOAuthController],
  providers: [CloudAccountService, S3CloudAccountService, S3CompatibleProviderFactory, S3CloudProviderAdapterFactory, AccountImpactService, TokenEncryptionService, OAuthStateService, ProviderRegistryService, CloudProviderResolver],
  exports: [CloudAccountService, TokenEncryptionService, CloudProviderResolver, ProviderRegistryService],
})
export class CloudAccountsModule {}
