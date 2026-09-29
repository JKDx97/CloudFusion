import { Readable } from 'node:stream';
import { CloudFile, CloudDownload, CloudAccountInfo, CloudQuota } from './cloud-file.interface';
import { CloudProvider } from './cloud-provider.enum';

export interface ProviderTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
}

export interface ProviderUploadInput {
  stream: Readable;
  name: string;
  mimeType?: string;
  size?: number;
  parentId?: string;
}

export interface ProviderOAuthCallbackContext {
  hostname?: string;
  locationId?: string;
}

export interface CloudProviderAdapter {
  readonly provider: CloudProvider;
  /** True only for providers whose documented access tokens have no expiry/refresh token. */
  readonly accessTokenMayNotExpire?: boolean;

  exchangeAuthorizationCode(code: string, callbackContext?: ProviderOAuthCallbackContext): Promise<{
    account: CloudAccountInfo;
    tokens: ProviderTokenSet;
  }>;

  getAuthorizationUrl(state: string): string;

  refreshAccessToken(refreshToken: string): Promise<ProviderTokenSet>;

  revokeAuthorization(refreshToken: string): Promise<void>;

  listFiles(accessToken: string, accountId: string, parentId?: string): Promise<CloudFile[]>;
  searchFiles(accessToken: string, accountId: string, query: string): Promise<CloudFile[]>;
  getFile(accessToken: string, accountId: string, fileId: string): Promise<CloudFile>;
  uploadFile(accessToken: string, accountId: string, input: ProviderUploadInput): Promise<CloudFile>;
  downloadFile(accessToken: string, accountId: string, fileId: string): Promise<CloudDownload>;
  createFolder(accessToken: string, accountId: string, name: string, parentId?: string): Promise<CloudFile>;
  renameItem(accessToken: string, accountId: string, fileId: string, name: string): Promise<CloudFile>;
  deleteItem(accessToken: string, accountId: string, fileId: string): Promise<void>;
  getStorageQuota(accessToken: string, accountId: string): Promise<CloudQuota>;
}
