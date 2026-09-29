import { ConfigService } from '@nestjs/config';
import { BoxClient, BoxDeveloperTokenAuth, BoxOAuth, OAuthConfig } from 'box-node-sdk';
import { Readable } from 'node:stream';
import { BoxAdapter } from './box.adapter';
import { BOX_OAUTH_SCOPES, BoxOAuthService } from './box-oauth.service';
import { ProviderErrorCode } from '../common/provider-error';

jest.mock('box-node-sdk', () => ({
  BoxClient: jest.fn(),
  BoxDeveloperTokenAuth: jest.fn(),
  BoxOAuth: jest.fn(),
  OAuthConfig: jest.fn(),
}));

const mockClient = {
  folders: {
    getFolderItems: jest.fn(),
    getFolderById: jest.fn(),
    createFolder: jest.fn(),
    updateFolderById: jest.fn(),
    deleteFolderById: jest.fn(),
  },
  files: {
    getFileById: jest.fn(),
    updateFileById: jest.fn(),
    deleteFileById: jest.fn(),
  },
  uploads: { uploadFile: jest.fn() },
  chunkedUploads: { uploadBigFile: jest.fn() },
  downloads: { downloadFile: jest.fn() },
  search: { searchForContent: jest.fn() },
  users: { getUserMe: jest.fn() },
};

const mockOAuth = {
  tokenStorage: { store: jest.fn(), get: jest.fn(), clear: jest.fn() },
  getAuthorizeUrl: jest.fn(),
  getTokensAuthorizationCodeGrant: jest.fn(),
  refreshToken: jest.fn(),
  revokeToken: jest.fn(),
};

describe('Box OAuth and provider adapter', () => {
  let config: ConfigService;
  let oauth: BoxOAuthService;
  let adapter: BoxAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    config = {
      get: jest.fn((key: string) => ({
        'cloud.box.clientId': 'box-client-id',
        'cloud.box.clientSecret': 'box-client-secret',
        'cloud.box.redirectUri': 'http://localhost:3000/cloud-accounts/box/callback',
        'cloud.box.enabled': true,
      } as Record<string, unknown>)[key]),
    } as unknown as ConfigService;
    (OAuthConfig as unknown as jest.Mock).mockImplementation((value: unknown) => value);
    (BoxOAuth as unknown as jest.Mock).mockImplementation(() => mockOAuth);
    (BoxClient as unknown as jest.Mock).mockImplementation(() => mockClient);
    (BoxDeveloperTokenAuth as unknown as jest.Mock).mockImplementation((value: unknown) => value);
    mockOAuth.getAuthorizeUrl.mockReturnValue('https://account.box.com/api/oauth2/authorize?state=test-state');
    mockOAuth.getTokensAuthorizationCodeGrant.mockResolvedValue({
      accessToken: 'access-token', refreshToken: 'refresh-token', expiresIn: 3600,
    });
    mockOAuth.refreshToken.mockResolvedValue({
      accessToken: 'rotated-access-token', refreshToken: 'rotated-refresh-token', expiresIn: 3600,
    });
    mockClient.users.getUserMe.mockResolvedValue({
      id: 'box-user-1', name: 'Box User', login: 'box@example.com', spaceUsed: 123, spaceAmount: 10000,
    });
    oauth = new BoxOAuthService(config);
    adapter = new BoxAdapter(oauth);
  });

  it('generates an authorization-code URL with state, redirect and the read/write content scope', () => {
    expect(oauth.getAuthorizationUrl('secure-state')).toBe('https://account.box.com/api/oauth2/authorize?state=test-state');
    expect(mockOAuth.getAuthorizeUrl).toHaveBeenCalledWith({
      responseType: 'code',
      redirectUri: 'http://localhost:3000/cloud-accounts/box/callback',
      scope: BOX_OAUTH_SCOPES.join(' '),
      state: 'secure-state',
    });
  });

  it('exchanges the authorization code and reads profile/quota without exposing tokens', async () => {
    const result = await adapter.exchangeAuthorizationCode('short-lived-code');
    expect(mockOAuth.getTokensAuthorizationCodeGrant).toHaveBeenCalledWith('short-lived-code');
    expect(mockClient.users.getUserMe).toHaveBeenCalledWith({ fields: ['id', 'name', 'login', 'space_used', 'space_amount'] });
    expect(result.account).toEqual({
      providerAccountId: 'box-user-1', email: 'box@example.com', displayName: 'Box User',
      quota: { used: 123, total: 10000 },
    });
    expect(result.tokens).toEqual(expect.objectContaining({ accessToken: 'access-token', refreshToken: 'refresh-token' }));
  });

  it('stores only the provided refresh credential in transient SDK storage before rotating it', async () => {
    const token = await adapter.refreshAccessToken('encrypted-at-rest-refresh-token');
    expect(mockOAuth.tokenStorage.store).toHaveBeenCalledWith({ refreshToken: 'encrypted-at-rest-refresh-token' });
    expect(token).toEqual(expect.objectContaining({ accessToken: 'rotated-access-token', refreshToken: 'rotated-refresh-token' }));
  });

  it('revokes the current OAuth token on disconnect', async () => {
    await adapter.revokeAuthorization('refresh-token');
    expect(mockOAuth.refreshToken).toHaveBeenCalledTimes(1);
    expect(mockOAuth.revokeToken).toHaveBeenCalledTimes(1);
  });

  it('lists Box files and folders through the common file contract', async () => {
    mockClient.folders.getFolderItems.mockResolvedValue({
      entries: [
        { id: 'file-1', type: 'file', name: 'report.pdf', size: 512, parent: { id: '0' } },
        { id: 'folder-1', type: 'folder', name: 'Reports', parent: { id: '0' } },
      ],
      totalCount: 2,
    });
    const items = await adapter.listFiles('access-token', 'account-1');
    expect(mockClient.folders.getFolderItems).toHaveBeenCalledWith('0', expect.objectContaining({ queryParams: expect.objectContaining({ limit: 1000 }) }));
    expect(items).toEqual([
      expect.objectContaining({ id: 'file-1', name: 'report.pdf', type: 'file', size: 512, parentId: '0' }),
      expect.objectContaining({ id: 'folder-1', name: 'Reports', type: 'folder' }),
    ]);
  });

  it('uses direct upload for small files and chunked upload for large files', async () => {
    mockClient.uploads.uploadFile.mockResolvedValue({ entries: [{ id: 'small-1', type: 'file', name: 'small.txt', size: 3 }] });
    await adapter.uploadFile('access-token', 'account-1', {
      stream: Readable.from('abc'), name: 'small.txt', size: 3,
    });
    expect(mockClient.uploads.uploadFile).toHaveBeenCalledWith(expect.objectContaining({
      attributes: { name: 'small.txt', parent: { id: '0' } },
    }));

    mockClient.chunkedUploads.uploadBigFile.mockResolvedValue({ id: 'large-1', type: 'file', name: 'large.bin', size: 60 * 1024 * 1024 });
    await adapter.uploadFile('access-token', 'account-1', {
      stream: Readable.from([]), name: 'large.bin', size: 60 * 1024 * 1024,
    });
    expect(mockClient.chunkedUploads.uploadBigFile).toHaveBeenCalledWith(expect.any(Readable), 'large.bin', 60 * 1024 * 1024, '0');
  });

  it('downloads a file as a readable stream using the official SDK', async () => {
    mockClient.files.getFileById.mockResolvedValue({ id: 'file-2', type: 'file', name: 'download.txt', size: 8 });
    mockClient.downloads.downloadFile.mockResolvedValue(Readable.from('contents'));
    const result = await adapter.downloadFile('access-token', 'account-1', 'file-2');
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('contents');
    expect(result).toEqual(expect.objectContaining({ fileName: 'download.txt', size: 8 }));
  });

  it('maps Box API rate limits to the universal provider error', async () => {
    mockClient.folders.getFolderItems.mockRejectedValue({ statusCode: 429 });
    await expect(adapter.listFiles('access-token', 'account-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: ProviderErrorCode.PROVIDER_RATE_LIMITED }),
      status: 429,
    });
  });
});
