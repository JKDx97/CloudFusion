import { Injectable } from '@nestjs/common';
import { drive_v3, google } from 'googleapis';
import { CloudFile, CloudAccountInfo, CloudDownload, CloudQuota } from '../common/cloud-file.interface';
import { CloudProvider } from '../common/cloud-provider.enum';
import { CloudProviderAdapter, ProviderTokenSet, ProviderUploadInput } from '../common/cloud-provider.interface';
import { GoogleDriveOAuthService } from './google-drive-oauth.service';

const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';

@Injectable()
export class GoogleDriveAdapter implements CloudProviderAdapter {
  readonly provider = CloudProvider.GOOGLE_DRIVE;

  constructor(private readonly oauth: GoogleDriveOAuthService) {}

  getAuthorizationUrl(state: string): string {
    return this.oauth.getAuthorizationUrl(state);
  }

  exchangeAuthorizationCode(code: string): Promise<{ account: CloudAccountInfo; tokens: ProviderTokenSet }> {
    return this.oauth.exchangeAuthorizationCode(code);
  }

  refreshAccessToken(refreshToken: string): Promise<ProviderTokenSet> {
    return this.oauth.refreshAccessToken(refreshToken);
  }

  revokeAuthorization(refreshToken: string): Promise<void> {
    return this.oauth.revokeAuthorization(refreshToken);
  }

  async listFiles(accessToken: string, accountId: string, parentId?: string): Promise<CloudFile[]> {
    const api = this.drive(accessToken);
    const parent = escapeQuery(parentId ?? 'root');
    const response = await api.files.list({
      q: `'${parent}' in parents and trashed = false`,
      pageSize: 1000,
      orderBy: 'folder,name',
      fields: 'files(id,name,mimeType,size,parents,createdTime,modifiedTime,webViewLink,thumbnailLink)',
    });
    return (response.data.files ?? []).map((file) => this.mapFile(file, accountId));
  }

  async getFile(accessToken: string, accountId: string, fileId: string): Promise<CloudFile> {
    const response = await this.drive(accessToken).files.get({
      fileId,
      fields: 'id,name,mimeType,size,parents,createdTime,modifiedTime,webViewLink,thumbnailLink',
    });
    return this.mapFile(response.data, accountId);
  }

  async uploadFile(accessToken: string, accountId: string, input: ProviderUploadInput): Promise<CloudFile> {
    const response = await this.drive(accessToken).files.create({
      requestBody: {
        name: input.name,
        mimeType: input.mimeType,
        parents: input.parentId ? [input.parentId] : ['root'],
      },
      media: { mimeType: input.mimeType ?? 'application/octet-stream', body: input.stream },
      fields: 'id,name,mimeType,size,parents,createdTime,modifiedTime,webViewLink,thumbnailLink',
    });
    return this.mapFile(response.data, accountId);
  }

  async downloadFile(accessToken: string, accountId: string, fileId: string): Promise<CloudDownload> {
    const file = await this.getFile(accessToken, accountId, fileId);
    const response = await this.drive(accessToken).files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' },
    );
    return {
      stream: response.data,
      fileName: file.name,
      mimeType: file.mimeType,
      size: file.size,
    };
  }

  async createFolder(accessToken: string, accountId: string, name: string, parentId?: string): Promise<CloudFile> {
    const response = await this.drive(accessToken).files.create({
      requestBody: {
        name,
        mimeType: GOOGLE_FOLDER,
        parents: parentId ? [parentId] : ['root'],
      },
      fields: 'id,name,mimeType,size,parents,createdTime,modifiedTime,webViewLink,thumbnailLink',
    });
    return this.mapFile(response.data, accountId);
  }

  async renameItem(accessToken: string, accountId: string, fileId: string, name: string): Promise<CloudFile> {
    const response = await this.drive(accessToken).files.update({
      fileId,
      requestBody: { name },
      fields: 'id,name,mimeType,size,parents,createdTime,modifiedTime,webViewLink,thumbnailLink',
    });
    return this.mapFile(response.data, accountId);
  }

  async deleteItem(accessToken: string, _accountId: string, fileId: string): Promise<void> {
    await this.drive(accessToken).files.delete({ fileId });
  }

  async getStorageQuota(accessToken: string, _accountId: string): Promise<CloudQuota> {
    const response = await this.drive(accessToken).about.get({ fields: 'storageQuota' });
    return {
      used: Number(response.data.storageQuota?.usage ?? 0),
      total: response.data.storageQuota?.limit ? Number(response.data.storageQuota.limit) : null,
    };
  }

  private drive(accessToken: string): drive_v3.Drive {
    return google.drive({ version: 'v3', auth: this.oauth.createClient(accessToken) });
  }

  private mapFile(file: drive_v3.Schema$File, accountId: string): CloudFile {
    return {
      id: file.id ?? '',
      provider: this.provider,
      accountId,
      name: file.name ?? 'Untitled',
      mimeType: file.mimeType ?? undefined,
      type: file.mimeType === GOOGLE_FOLDER ? 'folder' : 'file',
      size: file.size ? Number(file.size) : undefined,
      parentId: file.parents?.[0],
      createdAt: file.createdTime ?? undefined,
      modifiedAt: file.modifiedTime ?? undefined,
      webUrl: file.webViewLink ?? undefined,
      thumbnailUrl: file.thumbnailLink ?? undefined,
    };
  }
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

