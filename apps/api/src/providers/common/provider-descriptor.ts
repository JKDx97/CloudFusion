import { CloudProvider } from './cloud-provider.enum';

export enum ProviderId {
  GOOGLE_DRIVE = 'GOOGLE_DRIVE',
  ONEDRIVE = 'ONEDRIVE',
  DROPBOX = 'DROPBOX',
  BOX = 'BOX',
  PCLOUD = 'PCLOUD',
  MEGA = 'MEGA',
  AWS_S3 = 'AWS_S3',
  CLOUDFLARE_R2 = 'CLOUDFLARE_R2',
  WASABI = 'WASABI',
  BACKBLAZE_B2 = 'BACKBLAZE_B2',
  DIGITALOCEAN_SPACES = 'DIGITALOCEAN_SPACES',
  AZURE_BLOB = 'AZURE_BLOB',
  GOOGLE_CLOUD_STORAGE = 'GOOGLE_CLOUD_STORAGE',
  ORACLE_OBJECT_STORAGE = 'ORACLE_OBJECT_STORAGE',
  IBM_COS = 'IBM_COS',
  CUSTOM_S3 = 'CUSTOM_S3',
  MEDIAFIRE = 'MEDIAFIRE',
}

export enum ProviderCategory {
  CONSUMER_DRIVE = 'CONSUMER_DRIVE',
  OBJECT_STORAGE = 'OBJECT_STORAGE',
  SELF_HOSTED = 'SELF_HOSTED',
  EXPERIMENTAL = 'EXPERIMENTAL',
}

export enum ProviderAuthenticationType {
  OAUTH2 = 'OAUTH2',
  ACCESS_KEY = 'ACCESS_KEY',
  API_TOKEN = 'API_TOKEN',
  SERVICE_ACCOUNT = 'SERVICE_ACCOUNT',
  CUSTOM = 'CUSTOM',
  UNKNOWN = 'UNKNOWN',
}

export enum ProviderSupportStatus {
  STABLE = 'STABLE',
  BETA = 'BETA',
  EXPERIMENTAL = 'EXPERIMENTAL',
  COMING_SOON = 'COMING_SOON',
  UNAVAILABLE = 'UNAVAILABLE',
}

export interface ProviderCapabilities {
  list: boolean;
  folders: boolean;
  search: boolean;
  rename: boolean;
  move: boolean;
  copy: boolean;
  multipartUpload: boolean;
  resumableUpload: boolean;
  rangeDownload: boolean;
  nativeVersioning: boolean;
  checksums: boolean;
  quota: boolean;
  thumbnails: boolean;
  sharing: boolean;
  serverSideCopy: boolean;
}

export interface ProviderDescriptor {
  id: ProviderId;
  displayName: string;
  category: ProviderCategory;
  icon: string;
  authenticationType: ProviderAuthenticationType;
  supportStatus: ProviderSupportStatus;
  capabilities: ProviderCapabilities;
  supportsQuota: boolean;
  supportsBuckets: boolean;
  supportsFolders: boolean;
}

export function emptyProviderCapabilities(): ProviderCapabilities {
  return {
    list: false,
    folders: false,
    search: false,
    rename: false,
    move: false,
    copy: false,
    multipartUpload: false,
    resumableUpload: false,
    rangeDownload: false,
    nativeVersioning: false,
    checksums: false,
    quota: false,
    thumbnails: false,
    sharing: false,
    serverSideCopy: false,
  };
}

export function providerId(provider: CloudProvider): ProviderId {
  switch (provider) {
    case CloudProvider.GOOGLE_DRIVE:
      return ProviderId.GOOGLE_DRIVE;
    case CloudProvider.ONEDRIVE:
      return ProviderId.ONEDRIVE;
  }
}
