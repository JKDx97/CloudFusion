import { BadRequestException, Injectable } from '@nestjs/common';
import { BoxClient, BoxDeveloperTokenAuth } from 'box-node-sdk';
import { Readable } from 'node:stream';
import { CloudAccountInfo, CloudDownload, CloudFile, CloudQuota } from '../common/cloud-file.interface';
import { CloudProvider } from '../common/cloud-provider.enum';
import { CloudProviderAdapter, ProviderTokenSet, ProviderUploadInput } from '../common/cloud-provider.interface';
import { ProviderErrorCode, ProviderException } from '../common/provider-error';
import { BoxOAuthService } from './box-oauth.service';

const BOX_FOLDER_ROOT = '0';
const BOX_PAGE_SIZE = 1000;
const BOX_MAX_LIST_PAGES = 50;
const BOX_SIMPLE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

@Injectable()
export class BoxAdapter implements CloudProviderAdapter {
  readonly provider = CloudProvider.BOX;

  constructor(private readonly oauth: BoxOAuthService) {}

  getAuthorizationUrl(state: string): string { return this.oauth.getAuthorizationUrl(state); }
  exchangeAuthorizationCode(code: string): Promise<{ account: CloudAccountInfo; tokens: ProviderTokenSet }> { return this.oauth.exchangeAuthorizationCode(code); }
  refreshAccessToken(refreshToken: string): Promise<ProviderTokenSet> { return this.oauth.refreshAccessToken(refreshToken); }
  revokeAuthorization(refreshToken: string): Promise<void> { return this.oauth.revokeAuthorization(refreshToken); }

  async listFiles(accessToken: string, accountId: string, parentId?: string): Promise<CloudFile[]> {
    try {
      const client = this.client(accessToken);
      const folderId = parentId ?? BOX_FOLDER_ROOT;
      let offset = 0;
      let totalCount = Number.POSITIVE_INFINITY;
      const entries: CloudFile[] = [];
      for (let page = 0; page < BOX_MAX_LIST_PAGES && offset < totalCount; page += 1) {
        const result = await client.folders.getFolderItems(folderId, {
          queryParams: {
            limit: BOX_PAGE_SIZE,
            offset,
            fields: ['id', 'name', 'type', 'size', 'parent', 'created_at', 'modified_at', 'shared_link'],
          },
        });
        const items = result.entries ?? [];
        entries.push(...items.flatMap((item) => item.type === 'file' || item.type === 'folder' ? [this.mapFile(item, accountId)] : []));
        totalCount = result.totalCount ?? (items.length < BOX_PAGE_SIZE ? offset + items.length : Number.POSITIVE_INFINITY);
        if (items.length === 0) break;
        offset += items.length;
      }
      return entries;
    } catch (error) {
      throw normalizeBoxError(error, ProviderErrorCode.PROVIDER_UNAVAILABLE);
    }
  }

  async searchFiles(accessToken: string, accountId: string, query: string): Promise<CloudFile[]> {
    try {
      const result = await this.client(accessToken).search.searchForContent({
        query,
        limit: 200,
        fields: ['id', 'name', 'type', 'size', 'parent', 'created_at', 'modified_at', 'shared_link'],
      });
      return (result.entries ?? []).flatMap((item) => item.type === 'file' || item.type === 'folder' ? [this.mapFile(item, accountId)] : []);
    } catch (error) {
      throw normalizeBoxError(error, ProviderErrorCode.PROVIDER_UNAVAILABLE);
    }
  }

  async getFile(accessToken: string, accountId: string, fileId: string): Promise<CloudFile> {
    try {
      return this.mapFile(await this.getItem(this.client(accessToken), fileId), accountId);
    } catch (error) {
      throw normalizeBoxError(error, ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND);
    }
  }

  async uploadFile(accessToken: string, accountId: string, input: ProviderUploadInput): Promise<CloudFile> {
    this.assertItemName(input.name);
    if (input.size == null) {
      throw new BadRequestException('Box upload requires a known file size');
    }
    try {
      const client = this.client(accessToken);
      const parentId = input.parentId ?? BOX_FOLDER_ROOT;
      const uploaded = input.size != null && input.size > BOX_SIMPLE_UPLOAD_MAX_BYTES
        ? await client.chunkedUploads.uploadBigFile(input.stream, input.name, input.size, parentId)
        : (await client.uploads.uploadFile({
          attributes: { name: input.name, parent: { id: parentId } },
          file: input.stream,
          fileFileName: input.name,
          fileContentType: input.mimeType ?? 'application/octet-stream',
        })).entries?.[0];
      if (!uploaded) throw new ProviderException(ProviderErrorCode.PROVIDER_UPLOAD_FAILED, 502);
      return this.mapFile(uploaded, accountId);
    } catch (error) {
      throw normalizeBoxError(error, ProviderErrorCode.PROVIDER_UPLOAD_FAILED);
    }
  }

  async downloadFile(accessToken: string, accountId: string, fileId: string): Promise<CloudDownload> {
    try {
      const client = this.client(accessToken);
      const metadata = await this.getItem(client, fileId);
      if (metadata.type !== 'file') throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
      const stream = await client.downloads.downloadFile(fileId);
      if (!stream) throw new ProviderException(ProviderErrorCode.PROVIDER_DOWNLOAD_FAILED, 502);
      const item = metadata as unknown as BoxMetadata;
      return {
        stream,
        fileName: item.name ?? fileId,
        mimeType: 'application/octet-stream',
        ...(typeof item.size === 'number' ? { size: item.size } : {}),
      };
    } catch (error) {
      throw normalizeBoxError(error, ProviderErrorCode.PROVIDER_DOWNLOAD_FAILED);
    }
  }

  async createFolder(accessToken: string, accountId: string, name: string, parentId?: string): Promise<CloudFile> {
    this.assertItemName(name);
    try {
      const folder = await this.client(accessToken).folders.createFolder({
        name,
        parent: { id: parentId ?? BOX_FOLDER_ROOT },
      });
      return this.mapFile(folder, accountId);
    } catch (error) {
      throw normalizeBoxError(error, ProviderErrorCode.PROVIDER_UPLOAD_FAILED);
    }
  }

  async renameItem(accessToken: string, accountId: string, fileId: string, name: string): Promise<CloudFile> {
    this.assertItemName(name);
    try {
      const client = this.client(accessToken);
      const item = await this.getItem(client, fileId);
      const updated = item.type === 'folder'
        ? await client.folders.updateFolderById(fileId, { requestBody: { name } })
        : await client.files.updateFileById(fileId, { requestBody: { name } });
      return this.mapFile(updated, accountId);
    } catch (error) {
      throw normalizeBoxError(error, ProviderErrorCode.PROVIDER_UPLOAD_FAILED);
    }
  }

  async deleteItem(accessToken: string, _accountId: string, fileId: string): Promise<void> {
    try {
      const client = this.client(accessToken);
      const item = await this.getItem(client, fileId);
      if (item.type === 'folder') await client.folders.deleteFolderById(fileId);
      else await client.files.deleteFileById(fileId);
    } catch (error) {
      throw normalizeBoxError(error, ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND);
    }
  }

  async getStorageQuota(accessToken: string, _accountId: string): Promise<CloudQuota> {
    try {
      const user = await this.client(accessToken).users.getUserMe({ fields: ['space_used', 'space_amount'] });
      return {
        used: typeof user.spaceUsed === 'number' ? user.spaceUsed : 0,
        total: typeof user.spaceAmount === 'number' ? user.spaceAmount : null,
      };
    } catch (error) {
      throw normalizeBoxError(error, ProviderErrorCode.PROVIDER_UNAVAILABLE);
    }
  }

  private client(accessToken: string): BoxClient {
    return this.oauth.createClient(accessToken);
  }

  private async getItem(client: BoxClient, id: string) {
    try {
      return await client.files.getFileById(id, {
        queryParams: { fields: ['id', 'name', 'type', 'size', 'parent', 'created_at', 'modified_at', 'shared_link'] },
      });
    } catch (error) {
      if (extractStatus(error) !== 404) throw error;
      return client.folders.getFolderById(id, {
        queryParams: { fields: ['id', 'name', 'type', 'parent', 'created_at', 'modified_at', 'shared_link'] },
      });
    }
  }

  private mapFile(item: object, accountId: string): CloudFile {
    const value = item as BoxMetadata;
    const type = value.type === 'folder' ? 'folder' : 'file';
    const result: CloudFile = {
      id: value.id,
      provider: this.provider,
      accountId,
      name: value.name ?? value.id,
      mimeType: type === 'folder' ? 'application/vnd.box.folder' : 'application/octet-stream',
      type,
    };
    if (type === 'file' && typeof value.size === 'number') result.size = value.size;
    if (value.parent?.id) result.parentId = value.parent.id;
    const createdAt = dateString(value.createdAt);
    const modifiedAt = dateString(value.modifiedAt);
    if (createdAt) result.createdAt = createdAt;
    if (modifiedAt) result.modifiedAt = modifiedAt;
    if (value.sharedLink?.url) result.webUrl = value.sharedLink.url;
    return result;
  }

  private assertItemName(name: string): void {
    if (!name.trim() || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.endsWith(' ')) {
      throw new BadRequestException('Box item name is invalid');
    }
  }
}

interface BoxMetadata {
  id: string;
  type: string;
  name?: string;
  size?: number;
  parent?: { id?: string };
  createdAt?: unknown;
  modifiedAt?: unknown;
  sharedLink?: { url?: string | null };
}

function dateString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null && 'value' in value) {
    const date = (value as { value: unknown }).value;
    if (date instanceof Date) return date.toISOString();
    if (typeof date === 'string') return date;
  }
  return undefined;
}

function extractStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } };
  const status = value.statusCode ?? value.status ?? value.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function normalizeBoxError(error: unknown, fallback: ProviderErrorCode): ProviderException {
  if (error instanceof ProviderException) return error;
  if (error instanceof BadRequestException) throw error;
  const status = extractStatus(error);
  if (status === 401) return new ProviderException(ProviderErrorCode.PROVIDER_AUTH_EXPIRED, 401);
  if (status === 403) return new ProviderException(ProviderErrorCode.PROVIDER_PERMISSION_DENIED, 403);
  if (status === 404) return new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
  if (status === 429) return new ProviderException(ProviderErrorCode.PROVIDER_RATE_LIMITED, 429);
  if (status && status >= 500) return new ProviderException(ProviderErrorCode.PROVIDER_UNAVAILABLE, 503);
  return new ProviderException(fallback, 502);
}
