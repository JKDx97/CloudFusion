import { CloudAccount } from '../../cloud-accounts/entities/cloud-account.entity';
import { CloudCredentialType } from '../../cloud-accounts/entities/cloud-credential-type.enum';
import { TokenEncryptionService } from '../../cloud-accounts/services/token-encryption.service';
import { StorageTarget } from '../object-storage/entities/storage-target.entity';
import { CloudAccountStatus, CloudProvider } from '../common/cloud-provider.enum';
import { ProviderErrorCode } from '../common/provider-error';
import { S3CompatibleProviderFactory } from './s3-compatible-provider.factory';
import { S3CloudProviderAdapterFactory } from './s3-cloud-provider-adapter.factory';

describe('S3CloudProviderAdapterFactory', () => {
  it('decrypts backend-only credentials and binds only enabled targets owned by that account', async () => {
    const target = Object.assign(new StorageTarget(), {
      id: 'target-id', cloudAccountId: 'account-id', type: 'S3_BUCKET', name: 'bucket',
      remoteIdentifier: 'bucket-name', region: 'us-east-1', endpoint: null, prefix: '',
      forcePathStyle: false, enabled: true,
    });
    const repository = { find: jest.fn().mockResolvedValue([target]) };
    const encryption = { decrypt: jest.fn().mockReturnValue(JSON.stringify({ accessKeyId: 'access', secretAccessKey: 'private' })) };
    const storageAdapter = {
      capabilities: {},
      listObjects: jest.fn().mockResolvedValue({ objects: [], isTruncated: false }),
      close: jest.fn(),
    };
    const s3Factory = { create: jest.fn().mockResolvedValue(storageAdapter) };
    const service = new S3CloudProviderAdapterFactory(
      repository as never,
      encryption as unknown as TokenEncryptionService,
      s3Factory as unknown as S3CompatibleProviderFactory,
    );
    const account = Object.assign(new CloudAccount(), {
      id: 'account-id', provider: CloudProvider.AWS_S3, credentialType: CloudCredentialType.ACCESS_KEY,
      credentialsEncrypted: 'encrypted', status: CloudAccountStatus.CONNECTED,
    });

    const adapter = await service.create(account);
    await expect(adapter.listFiles('', account.id, `cf-s3:target-id:folder:`)).resolves.toEqual([]);

    expect(repository.find).toHaveBeenCalledWith({ where: { cloudAccountId: account.id, enabled: true }, order: { createdAt: 'ASC' } });
    expect(s3Factory.create).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'bucket-name' }), {
      accessKeyId: 'access', secretAccessKey: 'private',
    });
  });

  it('rejects accounts without access-key credentials without attempting decryption', async () => {
    const repository = { find: jest.fn() };
    const encryption = { decrypt: jest.fn() };
    const service = new S3CloudProviderAdapterFactory(repository as never, encryption as never, {} as never);
    const account = Object.assign(new CloudAccount(), {
      id: 'account-id', provider: CloudProvider.AWS_S3, credentialType: CloudCredentialType.OAUTH2,
      credentialsEncrypted: null,
    });

    await expect(service.create(account)).rejects.toMatchObject({ response: { code: ProviderErrorCode.PROVIDER_AUTH_FAILED } });
    expect(encryption.decrypt).not.toHaveBeenCalled();
  });
});
