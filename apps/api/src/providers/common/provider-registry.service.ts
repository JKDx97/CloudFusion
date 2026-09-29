import { Injectable } from '@nestjs/common';
import { GoogleDriveAdapter } from '../google-drive/google-drive.adapter';
import { OneDriveAdapter } from '../onedrive/onedrive.adapter';
import { DropboxAdapter } from '../dropbox/dropbox.adapter';
import { BoxAdapter } from '../box/box.adapter';
import { CloudProvider } from './cloud-provider.enum';
import { CloudProviderAdapter } from './cloud-provider.interface';
import { ProviderErrorCode, ProviderException } from './provider-error';
import {
  emptyProviderCapabilities,
  ProviderAuthenticationType,
  ProviderCapabilities,
  ProviderCategory,
  ProviderDescriptor,
  ProviderId,
  ProviderSupportStatus,
  providerId,
} from './provider-descriptor';

const DRIVE_CAPABILITIES: Partial<ProviderCapabilities> = {
  list: true,
  folders: true,
  search: true,
  rename: true,
  quota: true,
  thumbnails: true,
};

const CATALOG: ProviderDescriptor[] = [
  descriptor(ProviderId.GOOGLE_DRIVE, 'Google Drive', ProviderCategory.CONSUMER_DRIVE, ProviderAuthenticationType.OAUTH2, ProviderSupportStatus.BETA, DRIVE_CAPABILITIES, { supportsQuota: true, supportsFolders: true }),
  descriptor(ProviderId.ONEDRIVE, 'OneDrive', ProviderCategory.CONSUMER_DRIVE, ProviderAuthenticationType.OAUTH2, ProviderSupportStatus.BETA, DRIVE_CAPABILITIES, { supportsQuota: true, supportsFolders: true }),
  descriptor(ProviderId.DROPBOX, 'Dropbox', ProviderCategory.CONSUMER_DRIVE, ProviderAuthenticationType.OAUTH2, ProviderSupportStatus.BETA, {
    list: true,
    folders: true,
    search: true,
    rename: true,
    resumableUpload: true,
    quota: true,
  }, { supportsQuota: true, supportsFolders: true }),
  descriptor(ProviderId.BOX, 'Box', ProviderCategory.CONSUMER_DRIVE, ProviderAuthenticationType.OAUTH2, ProviderSupportStatus.BETA, {
    list: true,
    folders: true,
    search: true,
    rename: true,
    resumableUpload: true,
    quota: true,
  }, { supportsQuota: true, supportsFolders: true }),
  descriptor(ProviderId.PCLOUD, 'pCloud', ProviderCategory.CONSUMER_DRIVE, ProviderAuthenticationType.OAUTH2, ProviderSupportStatus.COMING_SOON, {}, { supportsQuota: true, supportsFolders: true }),
  descriptor(ProviderId.MEGA, 'MEGA', ProviderCategory.CONSUMER_DRIVE, ProviderAuthenticationType.UNKNOWN, ProviderSupportStatus.COMING_SOON, {}, { supportsQuota: true, supportsFolders: true }),
  descriptor(ProviderId.AWS_S3, 'Amazon S3', ProviderCategory.OBJECT_STORAGE, ProviderAuthenticationType.ACCESS_KEY, ProviderSupportStatus.BETA, { list: true, copy: true, serverSideCopy: true, multipartUpload: true, resumableUpload: true, rangeDownload: true }, { supportsBuckets: true }),
  descriptor(ProviderId.CLOUDFLARE_R2, 'Cloudflare R2', ProviderCategory.OBJECT_STORAGE, ProviderAuthenticationType.ACCESS_KEY, ProviderSupportStatus.BETA, { list: true, copy: true, serverSideCopy: true, multipartUpload: true, resumableUpload: true, rangeDownload: true }, { supportsBuckets: true }),
  descriptor(ProviderId.WASABI, 'Wasabi', ProviderCategory.OBJECT_STORAGE, ProviderAuthenticationType.ACCESS_KEY, ProviderSupportStatus.BETA, { list: true }, { supportsBuckets: true }),
  descriptor(ProviderId.BACKBLAZE_B2, 'Backblaze B2', ProviderCategory.OBJECT_STORAGE, ProviderAuthenticationType.ACCESS_KEY, ProviderSupportStatus.BETA, { list: true }, { supportsBuckets: true }),
  descriptor(ProviderId.DIGITALOCEAN_SPACES, 'DigitalOcean Spaces', ProviderCategory.OBJECT_STORAGE, ProviderAuthenticationType.ACCESS_KEY, ProviderSupportStatus.BETA, { list: true }, { supportsBuckets: true }),
  descriptor(ProviderId.AZURE_BLOB, 'Azure Blob Storage', ProviderCategory.OBJECT_STORAGE, ProviderAuthenticationType.ACCESS_KEY, ProviderSupportStatus.COMING_SOON, {}, { supportsBuckets: true }),
  descriptor(ProviderId.GOOGLE_CLOUD_STORAGE, 'Google Cloud Storage', ProviderCategory.OBJECT_STORAGE, ProviderAuthenticationType.SERVICE_ACCOUNT, ProviderSupportStatus.COMING_SOON, {}, { supportsBuckets: true }),
  descriptor(ProviderId.ORACLE_OBJECT_STORAGE, 'Oracle Object Storage', ProviderCategory.OBJECT_STORAGE, ProviderAuthenticationType.ACCESS_KEY, ProviderSupportStatus.BETA, { list: true }, { supportsBuckets: true }),
  descriptor(ProviderId.IBM_COS, 'IBM Cloud Object Storage', ProviderCategory.OBJECT_STORAGE, ProviderAuthenticationType.ACCESS_KEY, ProviderSupportStatus.BETA, { list: true }, { supportsBuckets: true }),
  descriptor(ProviderId.CUSTOM_S3, 'S3 Compatible', ProviderCategory.SELF_HOSTED, ProviderAuthenticationType.CUSTOM, ProviderSupportStatus.BETA, { list: true }, { supportsBuckets: true }),
  descriptor(ProviderId.MEDIAFIRE, 'MediaFire', ProviderCategory.EXPERIMENTAL, ProviderAuthenticationType.UNKNOWN, ProviderSupportStatus.COMING_SOON, {}),
];

@Injectable()
export class ProviderRegistryService {
  private readonly adapters = new Map<CloudProvider, CloudProviderAdapter>();
  private readonly descriptors = new Map(CATALOG.map((entry) => [entry.id, entry]));

  constructor(googleDrive: GoogleDriveAdapter, oneDrive: OneDriveAdapter, dropbox: DropboxAdapter, box: BoxAdapter) {
    this.registerAdapter(googleDrive);
    this.registerAdapter(oneDrive);
    this.registerAdapter(dropbox);
    this.registerAdapter(box);
  }

  getCatalog(): ProviderDescriptor[] {
    return CATALOG.map((entry) => ({ ...entry, capabilities: { ...entry.capabilities } }));
  }

  getDescriptor(id: string): ProviderDescriptor | undefined {
    const entry = this.descriptors.get(id as ProviderId);
    return entry ? { ...entry, capabilities: { ...entry.capabilities } } : undefined;
  }

  resolve(provider: CloudProvider): CloudProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new ProviderException(ProviderErrorCode.PROVIDER_UNAVAILABLE, 503);
    }
    return adapter;
  }

  private registerAdapter(adapter: CloudProviderAdapter): void {
    if (this.adapters.has(adapter.provider)) throw new Error(`Duplicate provider adapter: ${adapter.provider}`);
    const id = providerId(adapter.provider);
    const entry = this.descriptors.get(id);
    if (!entry) throw new Error(`Provider descriptor is missing: ${id}`);
    this.adapters.set(adapter.provider, adapter);
  }
}

function descriptor(
  id: ProviderId,
  displayName: string,
  category: ProviderCategory,
  authenticationType: ProviderAuthenticationType,
  supportStatus: ProviderSupportStatus,
  capabilities: Partial<ProviderCapabilities>,
  options: { supportsQuota?: boolean; supportsBuckets?: boolean; supportsFolders?: boolean } = {},
): ProviderDescriptor {
  const mergedCapabilities = { ...emptyProviderCapabilities(), ...capabilities };
  return {
    id,
    displayName,
    category,
    icon: id.toLowerCase().replaceAll('_', '-'),
    authenticationType,
    supportStatus,
    capabilities: mergedCapabilities,
    supportsQuota: options.supportsQuota ?? mergedCapabilities.quota,
    supportsBuckets: options.supportsBuckets ?? false,
    supportsFolders: options.supportsFolders ?? mergedCapabilities.folders,
  };
}
