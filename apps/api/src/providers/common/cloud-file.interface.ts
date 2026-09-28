import { Readable } from 'node:stream';
import { CloudProvider } from './cloud-provider.enum';

export type CloudFileType = 'file' | 'folder';

export interface CloudFile {
  id: string;
  provider: CloudProvider;
  accountId: string;
  name: string;
  mimeType?: string;
  type: CloudFileType;
  size?: number;
  parentId?: string;
  createdAt?: string;
  modifiedAt?: string;
  webUrl?: string;
  thumbnailUrl?: string;
}

export interface CloudQuota {
  used: number;
  total: number | null;
}

export interface CloudAccountInfo {
  providerAccountId: string;
  email?: string;
  displayName?: string;
  quota?: CloudQuota;
}

export interface CloudDownload {
  stream: Readable;
  fileName: string;
  mimeType?: string;
  size?: number;
}
