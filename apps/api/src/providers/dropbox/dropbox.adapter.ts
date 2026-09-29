import { BadRequestException, Injectable } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Dropbox, downloadFile as downloadToFile, readerUpload, sizedReaderUpload, uploadFile } from 'dropbox';
import type { files } from 'dropbox';
import { CloudAccountInfo, CloudDownload, CloudFile, CloudQuota } from '../common/cloud-file.interface';
import { CloudProvider } from '../common/cloud-provider.enum';
import { CloudProviderAdapter, ProviderTokenSet, ProviderUploadInput } from '../common/cloud-provider.interface';
import { ProviderErrorCode, ProviderException } from '../common/provider-error';
import { DropboxOAuthService } from './dropbox-oauth.service';

@Injectable()
export class DropboxAdapter implements CloudProviderAdapter {
  readonly provider = CloudProvider.DROPBOX;

  constructor(private readonly oauth: DropboxOAuthService) {}

  getAuthorizationUrl(state: string): string { return this.oauth.getAuthorizationUrl(state); }
  exchangeAuthorizationCode(code: string): Promise<{ account: CloudAccountInfo; tokens: ProviderTokenSet }> { return this.oauth.exchangeAuthorizationCode(code); }
  refreshAccessToken(refreshToken: string): Promise<ProviderTokenSet> { return this.oauth.refreshAccessToken(refreshToken); }
  revokeAuthorization(refreshToken: string): Promise<void> { return this.oauth.revokeAuthorization(refreshToken); }

  async listFiles(accessToken: string, accountId: string, parentId?: string): Promise<CloudFile[]> {
    try {
      const client = this.client(accessToken);
      let page = (await client.filesListFolder({ path: parentId ?? '', limit: 2000 })).result;
      const items = [...page.entries];
      for (let index = 0; page.has_more && index < 19; index += 1) {
        page = (await client.filesListFolderContinue({ cursor: page.cursor })).result;
        items.push(...page.entries);
      }
      return items.flatMap((item) => item['.tag'] === 'file' || item['.tag'] === 'folder' ? [this.mapFile(item, accountId)] : []);
    } catch (error) {
      throw normalizeDropboxError(error, ProviderErrorCode.PROVIDER_UNAVAILABLE);
    }
  }

  async searchFiles(accessToken: string, accountId: string, query: string): Promise<CloudFile[]> {
    try {
      const result = (await this.client(accessToken).filesSearchV2({ query, options: { max_results: 100 } })).result;
      return result.matches.flatMap((match) => {
        const metadata = match.metadata['.tag'] === 'metadata' ? match.metadata.metadata : undefined;
        return metadata && (metadata['.tag'] === 'file' || metadata['.tag'] === 'folder') ? [this.mapFile(metadata, accountId)] : [];
      });
    } catch (error) {
      throw normalizeDropboxError(error, ProviderErrorCode.PROVIDER_UNAVAILABLE);
    }
  }

  async getFile(accessToken: string, accountId: string, fileId: string): Promise<CloudFile> {
    try {
      const metadata = (await this.client(accessToken).filesGetMetadata({ path: fileId })).result;
      if (metadata['.tag'] !== 'file' && metadata['.tag'] !== 'folder') throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
      return this.mapFile(metadata, accountId);
    } catch (error) {
      throw normalizeDropboxError(error, ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND);
    }
  }

  async uploadFile(accessToken: string, accountId: string, input: ProviderUploadInput): Promise<CloudFile> {
    try {
      const client = this.client(accessToken);
      const path = await this.destinationPath(client, input.parentId, input.name);
      const source = input.size == null ? readerUpload(input.stream) : sizedReaderUpload(input.stream, input.size);
      const result = await uploadFile(client, source, {
        path,
        mode: { '.tag': 'add' },
        autorename: true,
        mute: true,
      });
      return this.mapFile(result.metadata, accountId);
    } catch (error) {
      throw normalizeDropboxError(error, ProviderErrorCode.PROVIDER_UPLOAD_FAILED);
    }
  }

  async downloadFile(accessToken: string, accountId: string, fileId: string): Promise<CloudDownload> {
    const file = await this.getFile(accessToken, accountId, fileId);
    const directory = await mkdtemp(join(tmpdir(), 'cloudfusion-dropbox-'));
    const filePath = join(directory, randomUUID());
    try {
      const metadata = await downloadToFile(this.client(accessToken), fileId, filePath);
      const stream = createReadStream(filePath);
      stream.once('close', () => { void rm(directory, { recursive: true, force: true }).catch(() => undefined); });
      return {
        stream,
        fileName: metadata.metadata.name || file.name,
        mimeType: 'application/octet-stream',
        size: metadata.metadata.size,
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw normalizeDropboxError(error, ProviderErrorCode.PROVIDER_DOWNLOAD_FAILED);
    }
  }

  async createFolder(accessToken: string, accountId: string, name: string, parentId?: string): Promise<CloudFile> {
    try {
      const client = this.client(accessToken);
      const path = await this.destinationPath(client, parentId, name);
      const result = await client.filesCreateFolderV2({ path, autorename: false });
      return this.mapFile(result.result.metadata, accountId);
    } catch (error) {
      throw normalizeDropboxError(error, ProviderErrorCode.PROVIDER_UPLOAD_FAILED);
    }
  }

  async renameItem(accessToken: string, accountId: string, fileId: string, name: string): Promise<CloudFile> {
    try {
      this.assertItemName(name);
      const client = this.client(accessToken);
      const metadata = (await client.filesGetMetadata({ path: fileId })).result;
      if ((metadata['.tag'] !== 'file' && metadata['.tag'] !== 'folder') || !metadata.path_display) {
        throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
      }
      const parentPath = dirname(metadata.path_display.replace(/\\/g, '/'));
      const path = this.joinRemotePath(parentPath === '.' ? '' : parentPath, name);
      const result = await client.filesMoveV2({ from_path: fileId, to_path: path, autorename: false });
      return this.mapFile(result.result.metadata, accountId);
    } catch (error) {
      throw normalizeDropboxError(error, ProviderErrorCode.PROVIDER_UPLOAD_FAILED);
    }
  }

  async deleteItem(accessToken: string, _accountId: string, fileId: string): Promise<void> {
    try {
      await this.client(accessToken).filesDeleteV2({ path: fileId });
    } catch (error) {
      throw normalizeDropboxError(error, ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND);
    }
  }

  async getStorageQuota(accessToken: string, _accountId: string): Promise<CloudQuota> {
    try {
      const space = (await this.client(accessToken).usersGetSpaceUsage()).result;
      return { used: space.used, total: space.allocation['.tag'] === 'individual' ? space.allocation.allocated : null };
    } catch (error) {
      throw normalizeDropboxError(error, ProviderErrorCode.PROVIDER_UNAVAILABLE);
    }
  }

  private client(accessToken: string): Dropbox { return new Dropbox({ accessToken }); }

  private async destinationPath(client: Dropbox, parentId: string | undefined, name: string): Promise<string> {
    this.assertItemName(name);
    let parentPath = '';
    if (parentId) {
      const parent = (await client.filesGetMetadata({ path: parentId })).result;
      if (parent['.tag'] !== 'folder' || !parent.path_display) throw new BadRequestException('Dropbox parent folder is unavailable');
      parentPath = parent.path_display;
    }
    return this.joinRemotePath(parentPath, name);
  }

  private assertItemName(name: string): void {
    if (!name.trim() || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      throw new BadRequestException('Dropbox item name is invalid');
    }
  }

  private joinRemotePath(parent: string, name: string): string {
    const normalizedParent = parent === '/' ? '' : parent.replace(/\/$/, '');
    return `${normalizedParent}/${name}`;
  }

  private mapFile(
    file: files.MetadataReference | files.FileMetadataReference | files.FolderMetadataReference | files.FileMetadata | files.FolderMetadata,
    accountId: string,
  ): CloudFile {
    const isFolder = '.tag' in file ? file['.tag'] === 'folder' : !('size' in file);
    const item = file as files.MetadataReference & Partial<files.FileMetadataReference>;
    return {
      id: 'id' in item && typeof item.id === 'string' ? item.id : item.path_lower ?? item.name,
      provider: this.provider,
      accountId,
      name: item.name,
      mimeType: isFolder ? 'application/vnd.dropbox.folder' : 'application/octet-stream',
      type: isFolder ? 'folder' : 'file',
      ...(!isFolder && typeof item.size === 'number' ? { size: item.size } : {}),
      createdAt: item.client_modified,
      modifiedAt: item.server_modified,
      webUrl: item.preview_url,
    };
  }
}

function normalizeDropboxError(error: unknown, fallback: ProviderErrorCode): ProviderException {
  if (error instanceof ProviderException) return error;
  if (error instanceof BadRequestException) {
    throw error;
  }
  const status = error && typeof error === 'object' && 'status' in error ? Number((error as { status: unknown }).status) : undefined;
  if (status === 401) return new ProviderException(ProviderErrorCode.PROVIDER_AUTH_EXPIRED, 401);
  if (status === 403) return new ProviderException(ProviderErrorCode.PROVIDER_PERMISSION_DENIED, 403);
  if (status === 404 || status === 409 && fallback === ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND) {
    return new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
  }
  if (status === 429) return new ProviderException(ProviderErrorCode.PROVIDER_RATE_LIMITED, 429);
  if (status && status >= 500) return new ProviderException(ProviderErrorCode.PROVIDER_UNAVAILABLE, 503);
  return new ProviderException(fallback, 502);
}
