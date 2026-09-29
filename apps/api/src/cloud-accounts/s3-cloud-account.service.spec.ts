import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { CloudAccountService } from './cloud-account.service';
import { CloudAccount } from './entities/cloud-account.entity';
import { CloudCredentialType } from './entities/cloud-credential-type.enum';
import { S3CloudAccountService } from './s3-cloud-account.service';
import { StorageTarget } from '../providers/object-storage/entities/storage-target.entity';
import { CloudAccountStatus, CloudProvider } from '../providers/common/cloud-provider.enum';
import { S3CompatibleProviderFactory } from '../providers/s3/s3-compatible-provider.factory';

describe('S3CloudAccountService', () => {
  let service: S3CloudAccountService;
  let accountRepository: Record<string, jest.Mock>;
  let targetRepository: Record<string, jest.Mock>;
  let adapter: { testConnection: jest.Mock; close: jest.Mock };
  let factory: { create: jest.Mock };
  let encryption: { encrypt: jest.Mock; decrypt: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  const s3Input = {
    provider: CloudProvider.AWS_S3,
    bucket: 'my-bucket',
    region: 'us-east-1',
    accessKeyId: 'access-key',
    secretAccessKey: 'top-secret',
  };

  beforeEach(() => {
    adapter = {
      testConnection: jest.fn().mockResolvedValue({ success: true, latencyMs: 10, read: true, write: true, cleanup: true }),
      close: jest.fn(),
    };
    factory = { create: jest.fn().mockResolvedValue(adapter) };
    encryption = {
      encrypt: jest.fn((value: string) => `encrypted:${value}`),
      decrypt: jest.fn((value: string) => value.replace(/^encrypted:/, '')),
    };
    accountRepository = {
      findOne: jest.fn(),
      create: jest.fn((input: Partial<CloudAccount>) => Object.assign(new CloudAccount(), { id: 'account-1', ...input })),
      save: jest.fn(async (value: CloudAccount) => value),
    };
    targetRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((input: Partial<StorageTarget>) => Object.assign(new StorageTarget(), {
        id: 'target-1', createdAt: new Date(0), updatedAt: new Date(0), ...input,
      })),
      save: jest.fn(async (value: StorageTarget) => value),
    };
    const manager = {
      getRepository: (entity: typeof CloudAccount | typeof StorageTarget) =>
        entity === CloudAccount ? accountRepository : targetRepository,
    };
    dataSource = { transaction: jest.fn((callback: (manager: typeof manager) => unknown) => callback(manager)) };

    const cloudAccounts = new CloudAccountService({} as never, {} as never, {} as never, {} as never);
    service = new S3CloudAccountService(
      accountRepository as unknown as Repository<CloudAccount>,
      targetRepository as unknown as Repository<StorageTarget>,
      dataSource as unknown as DataSource,
      encryption as never,
      factory as unknown as S3CompatibleProviderFactory,
      cloudAccounts,
    );
  });

  it('checks read access only by default and always closes the adapter', async () => {
    await service.testConnection(s3Input);

    expect(adapter.testConnection).toHaveBeenCalledWith(false);
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it('encrypts credentials, saves the account and target, and returns no secret fields', async () => {
    accountRepository.findOne.mockResolvedValue(null);

    const result = await service.connect('user-1', s3Input);

    expect(adapter.testConnection).toHaveBeenCalledWith(false);
    expect(encryption.encrypt).toHaveBeenCalledWith(JSON.stringify({ accessKeyId: 'access-key', secretAccessKey: 'top-secret' }));
    expect(accountRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      credentialType: CloudCredentialType.ACCESS_KEY,
      credentialsEncrypted: expect.stringMatching(/^encrypted:/),
      status: CloudAccountStatus.CONNECTED,
    }));
    expect(targetRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      cloudAccountId: 'account-1', remoteIdentifier: 'my-bucket', type: 'S3_BUCKET',
    }));
    expect(JSON.stringify(result.account)).not.toContain('top-secret');
    expect(JSON.stringify(result.account)).not.toContain('credentialsEncrypted');
  });

  it('does not persist an account when the read check fails', async () => {
    adapter.testConnection.mockResolvedValue({ success: false, latencyMs: 10, read: false, errorCode: 'PROVIDER_AUTH_INVALID' });

    await expect(service.connect('user-1', s3Input)).rejects.toBeInstanceOf(BadRequestException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it('does not expose targets when the account belongs to another user', async () => {
    accountRepository.findOne.mockResolvedValue(null);

    await expect(service.listTargets('user-a', 'account-b')).rejects.toBeInstanceOf(NotFoundException);
    expect(targetRepository.find).not.toHaveBeenCalled();
  });

  it('decrypts credentials only on the server when adding a target', async () => {
    accountRepository.findOne.mockResolvedValue(Object.assign(new CloudAccount(), {
      id: 'account-1', userId: 'user-1', provider: CloudProvider.AWS_S3,
      credentialType: CloudCredentialType.ACCESS_KEY, credentialsEncrypted: 'encrypted:{"accessKeyId":"access-key","secretAccessKey":"top-secret"}',
    }));

    const result = await service.addTarget('user-1', 'account-1', {
      bucket: 'another-bucket', region: 'us-east-1',
    });

    expect(encryption.decrypt).toHaveBeenCalledTimes(1);
    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'another-bucket' }), {
      accessKeyId: 'access-key', secretAccessKey: 'top-secret',
    });
    expect(result.target.remoteIdentifier).toBe('another-bucket');
    expect(JSON.stringify(result)).not.toContain('top-secret');
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });
});
