import { NotFoundException } from '@nestjs/common';
import { CloudCredentialType } from './entities/cloud-credential-type.enum';
import { CloudAccountService } from './cloud-account.service';
import { CloudAccountStatus, CloudProvider } from '../providers/common/cloud-provider.enum';

describe('CloudAccountService ownership', () => {
  it('does not resolve an account belonging to another user', async () => {
    const repository = { findOne: jest.fn().mockResolvedValue(null) };
    const service = new CloudAccountService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.getOwnedAccount('user-a', 'account-b')).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'account-b', userId: 'user-a' } });
  });

  it('routes owned access-key accounts through the S3 account adapter factory', async () => {
    const account = {
      id: 'account-a',
      userId: 'user-a',
      provider: CloudProvider.AWS_S3,
      credentialType: CloudCredentialType.ACCESS_KEY,
      status: CloudAccountStatus.CONNECTED,
    };
    const adapter = { listFiles: jest.fn() };
    const repository = { findOne: jest.fn().mockResolvedValue(account) };
    const s3ProviderFactory = { create: jest.fn().mockResolvedValue(adapter) };
    const service = new CloudAccountService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      s3ProviderFactory as never,
    );

    const context = await service.getAuthorizedAccount('user-a', 'account-a');

    expect(context).toEqual({ account, adapter, accessToken: '' });
    expect(s3ProviderFactory.create).toHaveBeenCalledWith(account);
  });
});
