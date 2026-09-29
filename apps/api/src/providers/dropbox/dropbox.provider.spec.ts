import { ConfigService } from '@nestjs/config';
import { Dropbox, DropboxAuth, downloadFile, sizedReaderUpload, uploadFile } from 'dropbox';
import { Readable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { DropboxAdapter } from './dropbox.adapter';
import { DropboxOAuthService, DROPBOX_SCOPES } from './dropbox-oauth.service';
import { ProviderErrorCode } from '../common/provider-error';

jest.mock('dropbox', () => ({
  Dropbox: jest.fn(),
  DropboxAuth: jest.fn(),
  downloadFile: jest.fn(),
  readerUpload: jest.fn((stream: unknown) => stream),
  sizedReaderUpload: jest.fn((stream: unknown) => stream),
  uploadFile: jest.fn(),
}));

const mockDropboxClient = {
  filesListFolder: jest.fn(),
  filesListFolderContinue: jest.fn(),
  filesSearchV2: jest.fn(),
  filesGetMetadata: jest.fn(),
  filesCreateFolderV2: jest.fn(),
  filesMoveV2: jest.fn(),
  filesDeleteV2: jest.fn(),
  usersGetSpaceUsage: jest.fn(),
  usersGetCurrentAccount: jest.fn(),
  authTokenRevoke: jest.fn(),
};

const mockAuth = {
  getAccessTokenFromCode: jest.fn(),
  refreshAccessToken: jest.fn(),
  getAccessToken: jest.fn(),
  getAccessTokenExpiresAt: jest.fn(),
};

describe('Dropbox OAuth and provider adapter', () => {
  let config: ConfigService;
  let oauth: DropboxOAuthService;
  let adapter: DropboxAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    config = {
      get: jest.fn((key: string) => ({
        'cloud.dropbox.clientId': 'test-client-id',
        'cloud.dropbox.clientSecret': 'test-client-secret',
        'cloud.dropbox.redirectUri': 'http://localhost:3000/cloud-accounts/dropbox/callback',
        'cloud.dropbox.enabled': true,
      } as Record<string, unknown>)[key]),
    } as unknown as ConfigService;
    (Dropbox as unknown as jest.Mock).mockImplementation(() => mockDropboxClient);
    (DropboxAuth as unknown as jest.Mock).mockImplementation(() => mockAuth);
    mockDropboxClient.usersGetCurrentAccount.mockResolvedValue({ result: {
      account_id: 'dbid:123', email: 'user@example.com', name: { display_name: 'Dropbox User' },
    } });
    mockDropboxClient.usersGetSpaceUsage.mockResolvedValue({ result: {
      used: 42, allocation: { '.tag': 'individual', allocated: 1000 },
    } });
    mockAuth.getAccessTokenFromCode.mockResolvedValue({ result: {
      access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 14400,
      scope: DROPBOX_SCOPES.join(' '),
    } });
    mockAuth.refreshAccessToken.mockResolvedValue(undefined);
    mockAuth.getAccessToken.mockReturnValue('refreshed-access-token');
    mockAuth.getAccessTokenExpiresAt.mockReturnValue(new Date('2030-01-01T00:00:00Z'));
    oauth = new DropboxOAuthService(config);
    adapter = new DropboxAdapter(oauth);
  });

  it('requests offline OAuth with only the scopes needed for CloudFusion file operations', () => {
    const url = new URL(oauth.getAuthorizationUrl('opaque-state'));
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(url.searchParams.get('token_access_type')).toBe('offline');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('opaque-state');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(DROPBOX_SCOPES);
  });

  it('exchanges the server-side authorization code and retains the refresh token', async () => {
    const result = await adapter.exchangeAuthorizationCode('one-time-code');
    expect(mockAuth.getAccessTokenFromCode).toHaveBeenCalledWith(
      'http://localhost:3000/cloud-accounts/dropbox/callback', 'one-time-code',
    );
    expect(result.account).toEqual(expect.objectContaining({
      providerAccountId: 'dbid:123', email: 'user@example.com', displayName: 'Dropbox User',
      quota: { used: 42, total: 1000 },
    }));
    expect(result.tokens.refreshToken).toBe('refresh-token');
  });

  it('refreshes OAuth credentials and revokes authorization without exposing the token', async () => {
    const token = await adapter.refreshAccessToken('stored-refresh-token');
    expect(token.accessToken).toBe('refreshed-access-token');
    expect(token.refreshToken).toBe('stored-refresh-token');
    await adapter.revokeAuthorization('stored-refresh-token');
    expect(mockDropboxClient.authTokenRevoke).toHaveBeenCalledTimes(1);
  });

  it('maps Dropbox folder listings into the universal file contract', async () => {
    mockDropboxClient.filesListFolder.mockResolvedValue({ result: {
      entries: [{
        '.tag': 'file', id: 'id:file-1', name: 'report.pdf', path_display: '/report.pdf',
        size: 64, client_modified: '2026-09-29T10:00:00Z', server_modified: '2026-09-29T10:01:00Z',
      }, { '.tag': 'folder', id: 'id:folder-1', name: 'Reports', path_display: '/Reports' }],
      cursor: 'cursor-1', has_more: false,
    } });

    const files = await adapter.listFiles('access-token', 'account-1');
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual(expect.objectContaining({
      id: 'id:file-1', accountId: 'account-1', name: 'report.pdf', type: 'file', size: 64,
    }));
    expect(files[1]).toEqual(expect.objectContaining({ id: 'id:folder-1', type: 'folder' }));
  });

  it('uses the SDK resumable upload helper for known-size streams', async () => {
    const metadata = {
      id: 'id:uploaded', name: 'large.bin', path_display: '/large.bin', size: 9,
      client_modified: '2026-09-29T10:00:00Z', server_modified: '2026-09-29T10:01:00Z',
    };
    (uploadFile as jest.Mock).mockResolvedValue({ metadata });
    const result = await adapter.uploadFile('access-token', 'account-1', {
      stream: Readable.from(Buffer.from('123456789')), name: 'large.bin', size: 9,
    });
    expect(sizedReaderUpload).toHaveBeenCalledWith(expect.any(Readable), 9);
    expect(result).toEqual(expect.objectContaining({ id: 'id:uploaded', name: 'large.bin', size: 9 }));
  });

  it('rejects path separators in an item name instead of treating rename as a move', async () => {
    await expect(adapter.renameItem('access-token', 'account-1', 'id:file-1', '../other'))
      .rejects.toMatchObject({ status: 400 });
    expect(mockDropboxClient.filesGetMetadata).not.toHaveBeenCalled();
  });

  it('downloads through the official SDK file helper and streams the temporary file', async () => {
    mockDropboxClient.filesGetMetadata.mockResolvedValue({ result: {
      '.tag': 'file', id: 'id:file-2', name: 'download.txt', path_display: '/download.txt', size: 8,
    } });
    (downloadFile as jest.Mock).mockImplementation(async (_client: unknown, _path: string, destination: string) => {
      await writeFile(destination, 'contents');
      return { metadata: { name: 'download.txt', size: 8 } };
    });

    const download = await adapter.downloadFile('access-token', 'account-1', 'id:file-2');
    const buffers: Buffer[] = [];
    for await (const chunk of download.stream) buffers.push(Buffer.from(chunk));
    expect(Buffer.concat(buffers).toString()).toBe('contents');
    expect(download.fileName).toBe('download.txt');
  });

  it('maps provider throttling to the shared rate-limit error', async () => {
    mockDropboxClient.filesListFolder.mockRejectedValue({ status: 429 });
    await expect(adapter.listFiles('access-token', 'account-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: ProviderErrorCode.PROVIDER_RATE_LIMITED }),
      status: 429,
    });
  });
});
