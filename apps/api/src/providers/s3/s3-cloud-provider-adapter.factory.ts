import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CloudAccount } from '../../cloud-accounts/entities/cloud-account.entity';
import { CloudCredentialType } from '../../cloud-accounts/entities/cloud-credential-type.enum';
import { TokenEncryptionService } from '../../cloud-accounts/services/token-encryption.service';
import { StorageTarget } from '../object-storage/entities/storage-target.entity';
import { ObjectStorageCredentials } from '../object-storage/object-storage.interface';
import { CloudProvider } from '../common/cloud-provider.enum';
import { ProviderId, providerId } from '../common/provider-descriptor';
import { ProviderErrorCode, ProviderException } from '../common/provider-error';
import { S3CompatibleProviderFactory } from './s3-compatible-provider.factory';
import { S3CloudProviderAdapter } from './s3-cloud-provider.adapter';

const SUPPORTED_S3_PROVIDERS = new Set<ProviderId>([
  ProviderId.AWS_S3,
  ProviderId.CLOUDFLARE_R2,
  ProviderId.WASABI,
  ProviderId.BACKBLAZE_B2,
  ProviderId.DIGITALOCEAN_SPACES,
  ProviderId.ORACLE_OBJECT_STORAGE,
  ProviderId.IBM_COS,
  ProviderId.CUSTOM_S3,
]);

@Injectable()
export class S3CloudProviderAdapterFactory {
  constructor(
    @InjectRepository(StorageTarget) private readonly targets: Repository<StorageTarget>,
    private readonly encryption: TokenEncryptionService,
    private readonly s3Factory: S3CompatibleProviderFactory,
  ) {}

  async create(account: CloudAccount): Promise<S3CloudProviderAdapter> {
    if (account.credentialType !== CloudCredentialType.ACCESS_KEY || !account.credentialsEncrypted) {
      throw new ProviderException(ProviderErrorCode.PROVIDER_AUTH_FAILED, 401);
    }

    let id: ProviderId;
    try {
      id = providerId(account.provider);
    } catch {
      throw new ProviderException(ProviderErrorCode.PROVIDER_UNAVAILABLE, 503);
    }
    if (!SUPPORTED_S3_PROVIDERS.has(id)) throw new ProviderException(ProviderErrorCode.PROVIDER_UNAVAILABLE, 503);

    let credentials: ObjectStorageCredentials;
    try {
      const value = JSON.parse(this.encryption.decrypt(account.credentialsEncrypted)) as Partial<ObjectStorageCredentials>;
      if (typeof value.accessKeyId !== 'string' || !value.accessKeyId ||
        typeof value.secretAccessKey !== 'string' || !value.secretAccessKey ||
        value.sessionToken != null && typeof value.sessionToken !== 'string') {
        throw new Error('Invalid encrypted credentials payload');
      }
      credentials = {
        accessKeyId: value.accessKeyId,
        secretAccessKey: value.secretAccessKey,
        ...(value.sessionToken ? { sessionToken: value.sessionToken } : {}),
      };
    } catch {
      throw new ProviderException(ProviderErrorCode.PROVIDER_AUTH_FAILED, 401);
    }

    const targets = await this.targets.find({
      where: { cloudAccountId: account.id, enabled: true },
      order: { createdAt: 'ASC' },
    });
    return new S3CloudProviderAdapter(account.provider as CloudProvider, account.id, credentials, targets, this.s3Factory);
  }
}
