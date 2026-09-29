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
import { ProviderRegistryService } from '../providers/common/provider-registry.service';
import { ProvidersController } from '../providers/providers.controller';
import { AccountImpactService } from './account-impact.service';
import { StorageReplica } from '../virtual-fs/entities/storage-replica.entity';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { SnapshotEntry } from '../snapshots/entities/snapshot-entry.entity';
import { BackupPolicy } from '../backups/entities/backup-policy.entity';
import { BackupCopy } from '../backups/entities/backup-copy.entity';

@Module({
  imports: [TypeOrmModule.forFeature([CloudAccount, StorageReplica, FileVersion, SnapshotEntry, BackupPolicy, BackupCopy]), GoogleDriveModule, OneDriveModule],
  controllers: [CloudAccountsController, ProvidersController],
  providers: [CloudAccountService, AccountImpactService, TokenEncryptionService, OAuthStateService, ProviderRegistryService, CloudProviderResolver],
  exports: [CloudAccountService, TokenEncryptionService, CloudProviderResolver, ProviderRegistryService],
})
export class CloudAccountsModule {}
