import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { CloudFile, CloudAccountInfo, CloudDownload, CloudQuota } from '../common/cloud-file.interface';
import { CloudProvider } from '../common/cloud-provider.enum';
import { CloudProviderAdapter, ProviderTokenSet, ProviderUploadInput } from '../common/cloud-provider.interface';
import { OneDriveOAuthService } from './onedrive-oauth.service';

@Injectable()
export class OneDriveAdapter implements CloudProviderAdapter {
  readonly provider = CloudProvider.ONEDRIVE;

  constructor(private readonly oauth: OneDriveOAuthService) {}

  getAuthorizationUrl(state: string): string { return this.oauth.getAuthorizationUrl(state); }
  exchangeAuthorizationCode(code: string): Promise<{ account: CloudAccountInfo; tokens: ProviderTokenSet }> { return this.oauth.exchangeAuthorizationCode(code); }
  refreshAccessToken(refreshToken: string): Promise<ProviderTokenSet> { return this.oauth.refreshAccessToken(refreshToken); }
  revokeAuthorization(refreshToken: string): Promise<void> { return this.oauth.revokeAuthorization(refreshToken); }

  async listFiles(accessToken: string, accountId: string, parentId?: string): Promise<CloudFile[]> {
    const path = parentId ? `/me/drive/items/${encodeURIComponent(parentId)}/children` : '/me/drive/root/children';
    const items = await this.listAll(accessToken, path);
    return items.map((item) => this.mapFile(item, accountId));
  }

  async searchFiles(accessToken: string, accountId: string, query: string): Promise<CloudFile[]> {
    const escaped = query.replace(/'/g, "''");
    const items = await this.listAll(accessToken, `/me/drive/root/search(q='${encodeURIComponent(escaped)}')`);
    return items.map((item) => this.mapFile(item, accountId));
  }

  async getFile(accessToken: string, accountId: string, fileId: string): Promise<CloudFile> {
    return this.mapFile(await this.request(accessToken, `/me/drive/items/${encodeURIComponent(fileId)}`), accountId);
  }

  async uploadFile(accessToken: string, accountId: string, input: ProviderUploadInput): Promise<CloudFile> {
    const parent = input.parentId ? `/items/${encodeURIComponent(input.parentId)}` : '/root';
    const path = `/me/drive${parent}:/${encodeURIComponent(input.name)}:/content`;
    const response = await fetch(this.url(path), {
      method: 'PUT',
      headers: { 'Content-Type': input.mimeType ?? 'application/octet-stream', ...(input.size ? { 'Content-Length': String(input.size) } : {}) },
      body: input.stream as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const payload = await this.parse(response);
    return this.mapFile(payload, accountId);
  }

  async downloadFile(accessToken: string, accountId: string, fileId: string): Promise<CloudDownload> {
    const file = await this.getFile(accessToken, accountId, fileId);
    const response = await fetch(this.url(`/me/drive/items/${encodeURIComponent(fileId)}/content`), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok || !response.body) throw new Error(`Graph download failed: ${response.status}`);
    return { stream: Readable.fromWeb(response.body as any), fileName: file.name, mimeType: file.mimeType, size: file.size };
  }

  async createFolder(accessToken: string, accountId: string, name: string, parentId?: string): Promise<CloudFile> {
    const path = parentId ? `/me/drive/items/${encodeURIComponent(parentId)}/children` : '/me/drive/root/children';
    const item = await this.request(accessToken, path, {
      method: 'POST',
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
    });
    return this.mapFile(item, accountId);
  }

  async renameItem(accessToken: string, accountId: string, fileId: string, name: string): Promise<CloudFile> {
    const item = await this.request(accessToken, `/me/drive/items/${encodeURIComponent(fileId)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    return this.mapFile(item, accountId);
  }

  async deleteItem(accessToken: string, _accountId: string, fileId: string): Promise<void> {
    await this.request(accessToken, `/me/drive/items/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  }

  async getStorageQuota(accessToken: string, _accountId: string): Promise<CloudQuota> {
    const drive = await this.request(accessToken, '/me/drive');
    return { used: Number(drive.quota?.used ?? 0), total: drive.quota?.total == null ? null : Number(drive.quota.total) };
  }

  private async listAll(accessToken: string, path: string): Promise<any[]> {
    const items: any[] = [];
    let next: string | undefined = this.url(path);
    for (let page = 0; next && page < 20; page += 1) {
      const response = await fetch(next, { headers: { Authorization: `Bearer ${accessToken}` } });
      const payload = await this.parse(response);
      items.push(...(payload.value ?? []));
      next = payload['@odata.nextLink'];
    }
    return items;
  }

  private async request(accessToken: string, path: string, init: RequestInit = {}): Promise<any> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return this.parse(await fetch(this.url(path), { ...init, headers }));
  }

  private async parse(response: Response): Promise<any> {
    if (response.status === 204) return undefined;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error('Microsoft Graph request failed'), { status: response.status, response: { status: response.status, data: payload } });
    return payload;
  }

  private url(path: string): string { return `https://graph.microsoft.com/v1.0${path}`; }

  private mapFile(item: any, accountId: string): CloudFile {
    return {
      id: String(item.id),
      provider: this.provider,
      accountId,
      name: item.name ?? 'Untitled',
      mimeType: item.file?.mimeType ?? 'application/octet-stream',
      type: item.folder ? 'folder' : 'file',
      size: item.size == null ? undefined : Number(item.size),
      parentId: item.parentReference?.id,
      createdAt: item.createdDateTime,
      modifiedAt: item.lastModifiedDateTime,
      webUrl: item.webUrl,
      thumbnailUrl: item.thumbnails?.[0]?.large?.url ?? item.thumbnails?.[0]?.medium?.url,
    };
  }
}
