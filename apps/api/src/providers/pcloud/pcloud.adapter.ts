import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { CloudAccountInfo, CloudDownload, CloudFile, CloudQuota } from '../common/cloud-file.interface';
import { CloudProvider } from '../common/cloud-provider.enum';
import { CloudProviderAdapter, ProviderOAuthCallbackContext, ProviderTokenSet, ProviderUploadInput } from '../common/cloud-provider.interface';
import { ProviderErrorCode, ProviderException } from '../common/provider-error';

const TOKEN_PREFIX = 'cloudfusion:pcloud:v1:';
const REGIONAL_HOSTS = new Set(['api.pcloud.com', 'eapi.pcloud.com']);
const LINK_HOST_PATTERN = /^(?:[a-z0-9-]+\.)*pcloud\.com$/i;
const API_TIMEOUT_MS = 30_000;

interface PCloudTokenContext { accessToken: string; hostname: string }
interface PCloudResponse {
  result?: number;
  error?: string;
  [key: string]: unknown;
}
interface PCloudMetadata {
  id?: string;
  name?: string;
  isfolder?: boolean;
  folderid?: string | number;
  fileid?: string | number;
  parentfolderid?: string | number;
  size?: number | string;
  contenttype?: string;
  created?: string;
  modified?: string;
  contents?: PCloudMetadata[];
  [key: string]: unknown;
}

@Injectable()
export class PCloudAdapter implements CloudProviderAdapter {
  readonly provider = CloudProvider.PCLOUD;
  readonly accessTokenMayNotExpire = true;

  constructor(private readonly config: ConfigService) {}

  getAuthorizationUrl(state: string): string {
    this.assertEnabled();
    const params = new URLSearchParams({
      client_id: this.required('cloud.pcloud.clientId'),
      response_type: 'code',
      redirect_uri: this.required('cloud.pcloud.redirectUri'),
      state,
    });
    return `https://my.pcloud.com/oauth2/authorize?${params.toString()}`;
  }

  async exchangeAuthorizationCode(code: string, callbackContext?: ProviderOAuthCallbackContext): Promise<{
    account: CloudAccountInfo;
    tokens: ProviderTokenSet;
  }> {
    this.assertEnabled();
    const hostname = this.regionalHost(callbackContext?.hostname);
    if (callbackContext?.locationId &&
      ((callbackContext.locationId === '1' && hostname !== 'api.pcloud.com') ||
        (callbackContext.locationId === '2' && hostname !== 'eapi.pcloud.com') ||
        !['1', '2'].includes(callbackContext.locationId))) {
      throw new BadRequestException('pCloud OAuth region does not match its API host');
    }
    if (!code || code.length > 4096) throw new BadRequestException('pCloud OAuth code is invalid');
    const form = new URLSearchParams({
      client_id: this.required('cloud.pcloud.clientId'),
      client_secret: this.required('cloud.pcloud.clientSecret'),
      code,
    });

    try {
      const token = await this.requestJson<PCloudResponse>(`https://${hostname}/oauth2_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      const accessToken = this.stringField(token, 'access_token');
      const context = this.encodeToken({ accessToken, hostname });
      const user = await this.api<PCloudResponse>(context, 'userinfo');
      const userId = this.stringValue(token.uid) ?? this.stringField(user, 'userid');
      const email = this.stringValue(user.email);
      return {
        account: {
          providerAccountId: userId,
          ...(email ? { email, displayName: email } : {}),
          quota: {
            used: this.numberValue(user.usedquota) ?? 0,
            total: this.numberValue(user.quota) ?? null,
          },
        },
        // pCloud's documented OAuth tokens currently do not expire and have no refresh token.
        // Keep the region with the opaque token; CloudAccountService encrypts this value at rest.
        tokens: { accessToken: context, scopes: [] },
      };
    } catch (error) {
      if (error instanceof ProviderException) throw error;
      throw new ProviderException(ProviderErrorCode.PROVIDER_UNAVAILABLE, 502);
    }
  }

  async refreshAccessToken(_refreshToken: string): Promise<ProviderTokenSet> {
    throw unsupported();
  }

  async revokeAuthorization(accessToken: string): Promise<void> {
    await this.api(accessToken, 'logout');
  }

  async listFiles(accessToken: string, accountId: string, parentId?: string): Promise<CloudFile[]> {
    const folderId = parentId ? this.parseId(parentId, 'folder') : '0';
    const response = await this.api<PCloudResponse>(accessToken, 'listfolder', { folderid: folderId });
    const metadata = this.objectField<PCloudMetadata>(response, 'metadata');
    const contents = Array.isArray(metadata.contents) ? metadata.contents : [];
    return contents
      .filter((item) => item.isfolder === true || item.isfolder === false)
      .map((item) => this.mapFile(item, accountId));
  }

  async searchFiles(): Promise<CloudFile[]> { throw unsupported(); }

  async getFile(accessToken: string, accountId: string, fileId: string): Promise<CloudFile> {
    const parsed = this.parseItemId(fileId);
    const response = parsed.kind === 'folder'
      ? await this.api<PCloudResponse>(accessToken, 'listfolder', { folderid: parsed.id })
      : await this.api<PCloudResponse>(accessToken, 'stat', { fileid: parsed.id });
    return this.mapFile(this.objectField<PCloudMetadata>(response, 'metadata'), accountId);
  }

  async uploadFile(accessToken: string, accountId: string, input: ProviderUploadInput): Promise<CloudFile> {
    this.assertItemName(input.name);
    const folderId = input.parentId ? this.parseId(input.parentId, 'folder') : '0';
    const context = this.decodeToken(accessToken);
    const boundary = `cloudfusion-${randomBytes(18).toString('hex')}`;
    const params = new URLSearchParams({
      folderid: folderId,
      filename: input.name,
      renameifexists: '1',
      nopartial: '1',
    });
    const url = new URL(`/uploadfile?${params.toString()}`, `https://${context.hostname}`);
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escapeFilename(input.name)}"\r\n` +
      `Content-Type: ${safeMimeType(input.mimeType)}\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const response = await this.streamUpload(url, context.accessToken, boundary, header, input.stream, footer, input.size);
    const metadata = this.arrayField<PCloudMetadata>(response, 'metadata')[0];
    if (metadata) return this.mapFile(metadata, accountId);
    const fileId = this.arrayField<string | number>(response, 'fileids')[0];
    if (fileId == null) throw new ProviderException(ProviderErrorCode.PROVIDER_UPLOAD_FAILED, 502);
    return this.getFile(accessToken, accountId, `f${fileId}`);
  }

  async downloadFile(accessToken: string, accountId: string, fileId: string): Promise<CloudDownload> {
    const file = await this.getFile(accessToken, accountId, fileId);
    if (file.type !== 'file') throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
    const parsed = this.parseItemId(fileId);
    const link = await this.api<PCloudResponse>(accessToken, 'getfilelink', { fileid: parsed.id, forcedownload: '1' });
    const host = this.arrayField<string>(link, 'hosts')[0];
    const path = this.stringField(link, 'path');
    if (!host || !LINK_HOST_PATTERN.test(host) || !path.startsWith('/')) {
      throw new ProviderException(ProviderErrorCode.PROVIDER_DOWNLOAD_FAILED, 502);
    }
    const downloadUrl = new URL(path, `https://${host}`);
    if (downloadUrl.protocol !== 'https:' || downloadUrl.hostname !== host) {
      throw new ProviderException(ProviderErrorCode.PROVIDER_DOWNLOAD_FAILED, 502);
    }
    const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(API_TIMEOUT_MS), redirect: 'error' });
    if (!response.ok || !response.body) throw new ProviderException(ProviderErrorCode.PROVIDER_DOWNLOAD_FAILED, response.status || 502);
    return {
      stream: Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>),
      fileName: file.name,
      mimeType: file.mimeType ?? 'application/octet-stream',
      ...(file.size == null ? {} : { size: file.size }),
    };
  }

  async createFolder(accessToken: string, accountId: string, name: string, parentId?: string): Promise<CloudFile> {
    this.assertItemName(name);
    const folderId = parentId ? this.parseId(parentId, 'folder') : '0';
    const response = await this.api<PCloudResponse>(accessToken, 'createfolder', { folderid: folderId, name });
    return this.mapFile(this.objectField<PCloudMetadata>(response, 'metadata'), accountId);
  }

  async renameItem(accessToken: string, accountId: string, fileId: string, name: string): Promise<CloudFile> {
    this.assertItemName(name);
    const source = await this.getFile(accessToken, accountId, fileId);
    if (source.name === name) return source;
    const parentId = source.parentId ?? 'd0';
    const siblings = await this.listFiles(accessToken, accountId, parentId);
    if (siblings.some((item) => item.id !== source.id && item.name === name)) {
      throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_ALREADY_EXISTS, 409);
    }
    const parsed = this.parseItemId(fileId);
    const method = parsed.kind === 'folder' ? 'renamefolder' : 'renamefile';
    const response = await this.api<PCloudResponse>(accessToken, method, {
      [parsed.kind === 'folder' ? 'folderid' : 'fileid']: parsed.id,
      toname: name,
    });
    return this.mapFile(this.objectField<PCloudMetadata>(response, 'metadata'), accountId);
  }

  async deleteItem(accessToken: string, _accountId: string, fileId: string): Promise<void> {
    const parsed = this.parseItemId(fileId);
    if (parsed.kind === 'folder' && parsed.id === '0') throw unsupported();
    const method = parsed.kind === 'folder' ? 'deletefolder' : 'deletefile';
    await this.api(accessToken, method, { [parsed.kind === 'folder' ? 'folderid' : 'fileid']: parsed.id });
  }

  async getStorageQuota(accessToken: string, _accountId: string): Promise<CloudQuota> {
    const user = await this.api<PCloudResponse>(accessToken, 'userinfo');
    return {
      used: this.numberValue(user.usedquota) ?? 0,
      total: this.numberValue(user.quota) ?? null,
    };
  }

  private async api<T extends PCloudResponse>(accessToken: string, method: string, params: Record<string, string> = {}): Promise<T> {
    const context = this.decodeToken(accessToken);
    const url = new URL(`/${method}`, `https://${context.hostname}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.requestJson<T>(url, {
      headers: { Authorization: `Bearer ${context.accessToken}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  }

  private async requestJson<T extends PCloudResponse>(url: string | URL, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch {
      throw new ProviderException(ProviderErrorCode.PROVIDER_UNAVAILABLE, 502);
    }
    const data = await response.json().catch(() => null) as T | null;
    if (response.status === 401) throw new ProviderException(ProviderErrorCode.PROVIDER_AUTH_EXPIRED, 401);
    if (response.status === 403) throw new ProviderException(ProviderErrorCode.PROVIDER_PERMISSION_DENIED, 403);
    if (response.status === 429) throw new ProviderException(ProviderErrorCode.PROVIDER_RATE_LIMITED, 429);
    if (!response.ok || !data || typeof data.result !== 'number') {
      throw new ProviderException(ProviderErrorCode.PROVIDER_UNAVAILABLE, response.status || 502);
    }
    if (data.result !== 0) throw this.providerError(data.result);
    return data;
  }

  private async streamUpload(
    url: URL,
    token: string,
    boundary: string,
    header: Buffer,
    source: Readable,
    footer: Buffer,
    size?: number,
  ): Promise<PCloudResponse> {
    const headers: Record<string, string | number> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    };
    if (size != null) headers['Content-Length'] = header.length + size + footer.length;
    return new Promise((resolve, reject) => {
      let settled = false;
      let request: ReturnType<typeof httpsRequest> | undefined;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        source.destroy();
        request?.destroy();
        reject(error);
      };
      request = httpsRequest(url, { method: 'POST', headers, timeout: API_TIMEOUT_MS }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('error', fail);
        response.on('end', () => {
          if (settled) return;
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PCloudResponse;
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300 || typeof data.result !== 'number') {
              throw new ProviderException(ProviderErrorCode.PROVIDER_UPLOAD_FAILED, response.statusCode || 502);
            }
            if (data.result !== 0) throw this.providerError(data.result);
            settled = true;
            resolve(data);
          } catch (error) {
            fail(error instanceof Error ? error : new Error('pCloud upload failed'));
          }
        });
      });
      request.on('error', fail);
      request.on('timeout', () => request.destroy(new Error('pCloud upload timed out')));
      source.on('error', fail);
      source.once('end', () => request?.end(footer));
      request.write(header);
      source.pipe(request, { end: false });
    });
  }

  private providerError(code: number): ProviderException {
    if ([1000, 2000].includes(code)) return new ProviderException(ProviderErrorCode.PROVIDER_AUTH_EXPIRED, 401);
    if (code === 2003) return new ProviderException(ProviderErrorCode.PROVIDER_PERMISSION_DENIED, 403);
    if (code === 2004) return new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_ALREADY_EXISTS, 409);
    if (code === 2006) return new ProviderException(ProviderErrorCode.PROVIDER_FOLDER_NOT_EMPTY, 409);
    if ([2005, 2009, 2010].includes(code)) return new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
    if (code === 2008) return new ProviderException(ProviderErrorCode.PROVIDER_QUOTA_EXCEEDED, 507);
    if (code === 4000) return new ProviderException(ProviderErrorCode.PROVIDER_RATE_LIMITED, 429);
    return new ProviderException(ProviderErrorCode.PROVIDER_UNAVAILABLE, 502);
  }

  private mapFile(metadata: PCloudMetadata, accountId: string): CloudFile {
    const id = this.metadataId(metadata);
    const folder = metadata.isfolder === true;
    const parentfolderid = this.stringValue(metadata.parentfolderid);
    return {
      id,
      provider: this.provider,
      accountId,
      name: typeof metadata.name === 'string' ? metadata.name : id,
      mimeType: folder ? 'application/vnd.cloudfusion.folder' : this.stringValue(metadata.contenttype) ?? 'application/octet-stream',
      type: folder ? 'folder' : 'file',
      ...(!folder && this.numberValue(metadata.size) != null ? { size: this.numberValue(metadata.size)! } : {}),
      ...(parentfolderid == null ? {} : { parentId: `d${parentfolderid}` }),
      ...(typeof metadata.created === 'string' ? { createdAt: this.parseDate(metadata.created) } : {}),
      ...(typeof metadata.modified === 'string' ? { modifiedAt: this.parseDate(metadata.modified) } : {}),
    };
  }

  private metadataId(metadata: PCloudMetadata): string {
    if (typeof metadata.id === 'string' && /^[df]\d+$/.test(metadata.id)) return metadata.id;
    const rawId = metadata.isfolder ? metadata.folderid : metadata.fileid;
    const id = this.stringValue(rawId);
    if (!id || !/^\d+$/.test(id)) throw new ProviderException(ProviderErrorCode.PROVIDER_UNAVAILABLE, 502);
    return `${metadata.isfolder ? 'd' : 'f'}${id}`;
  }

  private parseId(value: string, requiredKind: 'file' | 'folder'): string {
    const parsed = this.parseItemId(value);
    if (parsed.kind !== requiredKind) throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
    return parsed.id;
  }

  private parseItemId(value: string): { id: string; kind: 'file' | 'folder' } {
    const match = /^([df])(\d{1,20})$/.exec(value);
    if (!match) throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
    return { kind: match[1] === 'd' ? 'folder' : 'file', id: match[2] };
  }

  private encodeToken(context: PCloudTokenContext): string {
    return `${TOKEN_PREFIX}${Buffer.from(JSON.stringify(context), 'utf8').toString('base64url')}`;
  }

  private decodeToken(value: string): PCloudTokenContext {
    if (!value.startsWith(TOKEN_PREFIX)) throw new ProviderException(ProviderErrorCode.PROVIDER_AUTH_FAILED, 401);
    try {
      const encoded = value.slice(TOKEN_PREFIX.length);
      const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<PCloudTokenContext>;
      const hostname = this.regionalHost(parsed.hostname);
      if (typeof parsed.accessToken !== 'string' || !parsed.accessToken || Buffer.from(JSON.stringify(parsed), 'utf8').length > 8192) {
        throw new Error('Invalid pCloud token context');
      }
      return { accessToken: parsed.accessToken, hostname };
    } catch {
      throw new ProviderException(ProviderErrorCode.PROVIDER_AUTH_FAILED, 401);
    }
  }

  private regionalHost(value: unknown): string {
    if (typeof value !== 'string' || !REGIONAL_HOSTS.has(value.toLowerCase())) {
      throw new BadRequestException('pCloud returned an unsupported regional API host');
    }
    return value.toLowerCase();
  }

  private assertItemName(name: string): void {
    if (!name.trim() || name === '.' || name === '..' || /[\\/\u0000-\u001f]/.test(name)) {
      throw new BadRequestException('pCloud item name is invalid');
    }
  }

  private assertEnabled(): void {
    if (this.config.get<boolean>('cloud.pcloud.enabled') === false) throw new ServiceUnavailableException('pCloud integration is disabled');
  }

  private required(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) throw new BadRequestException('pCloud is not configured');
    return value;
  }

  private stringField<T extends object>(object: T, key: string): string {
    const value = (object as Record<string, unknown>)[key];
    if (typeof value !== 'string' || !value) throw new ProviderException(ProviderErrorCode.PROVIDER_UNAVAILABLE, 502);
    return value;
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  }

  private numberValue(value: unknown): number | undefined {
    const result = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(result) && result >= 0 ? result : undefined;
  }

  private objectField<T>(object: PCloudResponse, key: string): T {
    const value = object[key];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProviderException(ProviderErrorCode.PROVIDER_UNAVAILABLE, 502);
    return value as T;
  }

  private arrayField<T>(object: PCloudResponse, key: string): T[] {
    const value = object[key];
    return Array.isArray(value) ? value as T[] : [];
  }

  private parseDate(value: string): string | undefined {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
}

function escapeFilename(value: string): string {
  return value.replace(/["\\\r\n]/g, '_');
}

function safeMimeType(value?: string): string {
  return value && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)
    ? value
    : 'application/octet-stream';
}

function unsupported(): ProviderException {
  return new ProviderException(ProviderErrorCode.PROVIDER_CAPABILITY_NOT_SUPPORTED, 501);
}
