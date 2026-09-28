import { CloudSearchService } from './cloud-search.service';

describe('CloudSearchService', () => {
  it('queries connected accounts concurrently and returns partial failures', async () => {
    const accounts = {
      list: jest.fn().mockResolvedValue([{ id: 'drive', provider: 'GOOGLE_DRIVE', status: 'CONNECTED' }, { id: 'one', provider: 'ONEDRIVE', status: 'CONNECTED' }]),
      getAuthorizedAccount: jest.fn()
        .mockResolvedValueOnce({ accessToken: 'drive-token', adapter: { searchFiles: jest.fn().mockResolvedValue([{ id: 'a', accountId: 'drive', provider: 'GOOGLE_DRIVE', name: 'report.pdf', type: 'file' }]) } })
        .mockResolvedValueOnce({ accessToken: 'one-token', adapter: { searchFiles: jest.fn().mockRejectedValue(new Error('provider down')) } }),
    };
    const result = await new CloudSearchService(accounts as never).search('user', 'report');
    expect(result.results).toHaveLength(1);
    expect(result.failures).toEqual([{ accountId: 'one', provider: 'ONEDRIVE', message: 'Provider search failed' }]);
  });
});
