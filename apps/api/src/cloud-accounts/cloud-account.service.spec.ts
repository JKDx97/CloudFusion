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

  it('keeps an OAuth access token with no expiry or refresh token active', async () => {
    const account = {
      id: 'pcloud-account',
      userId: 'user-a',
      provider: CloudProvider.PCLOUD,
      credentialType: CloudCredentialType.OAUTH2,
      status: CloudAccountStatus.CONNECTED,
      accessTokenEncrypted: 'encrypted-pcloud-context',
      refreshTokenEncrypted: null,
      tokenExpiresAt: null,
    };
    const repository = { findOne: jest.fn().mockResolvedValue(account) };
    const resolver = { resolve: jest.fn().mockReturnValue({ accessTokenMayNotExpire: true, refreshAccessToken: jest.fn() }) };
    const encryption = { decrypt: jest.fn().mockReturnValue('opaque-non-expiring-access-token') };
    const service = new CloudAccountService(repository as never, resolver as never, {} as never, encryption as never);

    const context = await service.getAuthorizedAccount('user-a', account.id, true);

    expect(context.accessToken).toBe('opaque-non-expiring-access-token');
    expect(context.adapter).toBe(resolver.resolve.mock.results[0].value);
    expect(context.adapter.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('accepts a no-expiry OAuth provider that explicitly declares it has no refresh token', async () => {
    const adapter = {
      accessTokenMayNotExpire: true,
      exchangeAuthorizationCode: jest.fn().mockResolvedValue({
        account: { providerAccountId: 'pcloud-user', email: 'pcloud@example.com' },
        tokens: { accessToken: 'opaque-token', scopes: [] },
      }),
    };
    const accountRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value) => ({ id: 'new-account', ...value })),
      save: jest.fn(async (value) => value),
    };
    const service = new CloudAccountService(
      accountRepository as never,
      { resolve: jest.fn().mockReturnValue(adapter) } as never,
      { consume: jest.fn().mockReturnValue('user-a') } as never,
      { encrypt: jest.fn((value: string) => `encrypted:${value}`) } as never,
    );

    const result = await service.completeConnection(CloudProvider.PCLOUD, 'code', 'state', { hostname: 'api.pcloud.com' });

    expect(result.account.provider).toBe(CloudProvider.PCLOUD);
    expect(accountRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      credentialType: CloudCredentialType.OAUTH2,
      accessTokenEncrypted: 'encrypted:opaque-token',
      refreshTokenEncrypted: null,
      tokenExpiresAt: null,
    }));
    expect(adapter.exchangeAuthorizationCode).toHaveBeenCalledWith('code', { hostname: 'api.pcloud.com' });
  });
});
