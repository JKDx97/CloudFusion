import { ProviderErrorCode, ProviderException } from '../providers/common/provider-error';
import { CloudFilesService } from './cloud-files.service';

describe('CloudFilesService ownership', () => {
  it('does not call a provider when account access is rejected', async () => {
    const accounts = {
      getAuthorizedAccount: jest.fn().mockRejectedValue(new ProviderException(ProviderErrorCode.ACCOUNT_NOT_FOUND, 404)),
      list: jest.fn(),
    };
    const adapter = { listFiles: jest.fn() };
    const service = new CloudFilesService(accounts as never, { resolve: () => adapter } as never);

    await expect(service.list('user-a', 'account-b')).rejects.toMatchObject({ status: 404 });
    expect(adapter.listFiles).not.toHaveBeenCalled();
  });
});
