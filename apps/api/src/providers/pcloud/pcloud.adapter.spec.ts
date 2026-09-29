import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { ProviderErrorCode } from '../common/provider-error';
import { PCloudAdapter } from './pcloud.adapter';

describe('PCloudAdapter', () => {
  let adapter: PCloudAdapter;
  let fetchMock: jest.Mock;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    adapter = new PCloudAdapter({
      get: jest.fn((key: string) => ({
        'cloud.pcloud.clientId': 'client-id',
        'cloud.pcloud.clientSecret': 'secret-not-in-url',
        'cloud.pcloud.redirectUri': 'http://localhost:3000/cloud-accounts/pcloud/callback',
        'cloud.pcloud.enabled': true,
      } as Record<string, unknown>)[key]),
    } as unknown as ConfigService);
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it('uses server-side authorization-code OAuth and binds the returned EU API hostname', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ result: 0, uid: 123, access_token: 'pcloud-access-token' }))
      .mockResolvedValueOnce(json({ result: 0, userid: 123, email: 'person@example.com', usedquota: 5, quota: 100 }));

    const authorizationUrl = new URL(adapter.getAuthorizationUrl('one-use-state'));
    const result = await adapter.exchangeAuthorizationCode('oauth-code', { hostname: 'eapi.pcloud.com', locationId: '2' });
    const tokenRequest = fetchMock.mock.calls[0][1] as RequestInit;

    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrl.searchParams.get('state')).toBe('one-use-state');
    expect(fetchMock.mock.calls[0][0]).toBe('https://eapi.pcloud.com/oauth2_token');
    expect(String(tokenRequest.body)).toContain('client_secret=secret-not-in-url');
    expect(result.account).toMatchObject({ providerAccountId: '123', email: 'person@example.com', quota: { used: 5, total: 100 } });
    expect(result.tokens).toMatchObject({ scopes: [] });
    expect(result.tokens.refreshToken).toBeUndefined();
    expect(result.tokens.expiresAt).toBeUndefined();
    expect(result.tokens.accessToken).toMatch(/^cloudfusion:pcloud:v1:/);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer pcloud-access-token' });
  });

  it('rejects callback hosts outside pCloud regional API endpoints before exchanging the code', async () => {
    await expect(adapter.exchangeAuthorizationCode('oauth-code', { hostname: '127.0.0.1' })).rejects.toThrow('unsupported regional API host');
    await expect(adapter.exchangeAuthorizationCode('oauth-code', { hostname: 'api.pcloud.com', locationId: '2' })).rejects.toThrow('region does not match');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists provider-native folders and files with stable provider IDs', async () => {
    fetchMock.mockResolvedValueOnce(json({
      result: 0,
      metadata: {
        contents: [
          { id: 'd99', folderid: 99, parentfolderid: 0, isfolder: true, name: 'Documents' },
          { id: 'f345', fileid: 345, parentfolderid: 0, isfolder: false, name: 'notes.txt', size: 12, contenttype: 'text/plain' },
        ],
      },
    }));

    const files = await adapter.listFiles(token(), 'account-a');

    expect(fetchMock.mock.calls[0][0].toString()).toBe('https://api.pcloud.com/listfolder?folderid=0');
    expect(files.map(({ id, name, type, size }) => [id, name, type, size])).toEqual([
      ['d99', 'Documents', 'folder', undefined],
      ['f345', 'notes.txt', 'file', 12],
    ]);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer access-token' });
  });

  it('uploads with no-overwrite behavior and maps returned metadata', async () => {
    const upload = jest.fn().mockResolvedValue({
      result: 0,
      metadata: [{ id: 'f456', fileid: 456, parentfolderid: 0, isfolder: false, name: 'new file.txt', size: 4 }],
    });
    (adapter as unknown as { streamUpload: typeof upload }).streamUpload = upload;

    const file = await adapter.uploadFile(token(), 'account-a', {
      stream: Readable.from('data'), name: 'new file.txt', mimeType: 'text/plain\r\nX-Injected: bad', size: 4,
    });

    expect(upload.mock.calls[0][0].searchParams.get('filename')).toBe('new file.txt');
    expect(upload.mock.calls[0][0].searchParams.get('renameifexists')).toBe('1');
    expect(upload.mock.calls[0][0].searchParams.get('nopartial')).toBe('1');
    expect(upload.mock.calls[0][3].toString()).toContain('Content-Type: application/octet-stream');
    expect(upload.mock.calls[0][3].toString()).not.toContain('X-Injected');
    expect(file).toMatchObject({ id: 'f456', name: 'new file.txt', type: 'file', size: 4 });
  });

  it('streams a download using only an HTTPS pCloud content host', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ result: 0, metadata: { id: 'f345', fileid: 345, isfolder: false, name: 'notes.txt', size: 5, contenttype: 'text/plain' } }))
      .mockResolvedValueOnce(json({ result: 0, hosts: ['c63.pcloud.com'], path: '/download/opaque-name' }))
      .mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } }));

    const download = await adapter.downloadFile(token(), 'account-a', 'f345');
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

    expect(fetchMock.mock.calls[2][0].toString()).toBe('https://c63.pcloud.com/download/opaque-name');
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    expect(download).toMatchObject({ fileName: 'notes.txt', mimeType: 'text/plain', size: 5 });
  });

  it('does not rename over a sibling and reports non-empty folder deletion without recursion', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ result: 0, metadata: { id: 'f1', fileid: 1, parentfolderid: 0, isfolder: false, name: 'source.txt' } }))
      .mockResolvedValueOnce(json({ result: 0, metadata: { contents: [{ id: 'f2', fileid: 2, parentfolderid: 0, isfolder: false, name: 'taken.txt' }] } }));

    await expect(adapter.renameItem(token(), 'account-a', 'f1', 'taken.txt')).rejects.toMatchObject({
      response: { code: ProviderErrorCode.PROVIDER_OBJECT_ALREADY_EXISTS },
      status: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps official pCloud API errors to stable provider errors', async () => {
    fetchMock.mockResolvedValueOnce(json({ result: 2006, error: 'Folder is not empty' }));

    await expect(adapter.deleteItem(token(), 'account-a', 'd55')).rejects.toMatchObject({
      response: { code: ProviderErrorCode.PROVIDER_FOLDER_NOT_EMPTY },
      status: 409,
    });
  });
});

function token(accessToken = 'access-token', hostname = 'api.pcloud.com'): string {
  const encoded = Buffer.from(JSON.stringify({ accessToken, hostname }), 'utf8').toString('base64url');
  return `cloudfusion:pcloud:v1:${encoded}`;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
