export type CloudProvider = 'GOOGLE_DRIVE' | 'ONEDRIVE';
export type CloudAccountStatus = 'CONNECTED' | 'REAUTH_REQUIRED' | 'DISCONNECTED';

export interface CloudStorage {
  used: number;
  total: number | null;
}

export interface CloudAccount {
  id: string;
  provider: CloudProvider;
  email: string | null;
  displayName: string | null;
  status: CloudAccountStatus;
  storage: CloudStorage;
  scopes: string[];
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudStorageSummary {
  accounts: CloudAccount[];
  total: CloudStorage;
}

export interface CloudFile {
  id: string;
  provider: CloudProvider;
  accountId: string;
  name: string;
  mimeType?: string;
  type: 'file' | 'folder';
  size?: number;
  parentId?: string;
  createdAt?: string;
  modifiedAt?: string;
  webUrl?: string;
  thumbnailUrl?: string;
}
