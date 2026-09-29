import { CloudProvider } from './cloud-provider.enum';
import { CloudProviderAdapter } from './cloud-provider.interface';
import { ProviderRegistryService } from './provider-registry.service';
import { ProviderCategory, ProviderId, ProviderSupportStatus } from './provider-descriptor';

describe('ProviderRegistryService', () => {
  const googleDrive = { provider: CloudProvider.GOOGLE_DRIVE } as CloudProviderAdapter;
  const oneDrive = { provider: CloudProvider.ONEDRIVE } as CloudProviderAdapter;
  const dropboxAdapter = { provider: CloudProvider.DROPBOX } as CloudProviderAdapter;
  let registry: ProviderRegistryService;

  beforeEach(() => {
    registry = new ProviderRegistryService(googleDrive as never, oneDrive as never, dropboxAdapter as never);
  });

  it('publishes a safe catalog with explicitly unverified and coming-soon entries', () => {
    const catalog = registry.getCatalog();
    const google = catalog.find((entry) => entry.id === ProviderId.GOOGLE_DRIVE);
    const dropbox = catalog.find((entry) => entry.id === ProviderId.DROPBOX);
    const s3 = catalog.find((entry) => entry.id === ProviderId.AWS_S3);
    const r2 = catalog.find((entry) => entry.id === ProviderId.CLOUDFLARE_R2);

    expect(google?.supportStatus).toBe(ProviderSupportStatus.BETA);
    expect(google?.capabilities.search).toBe(true);
    expect(dropbox?.supportStatus).toBe(ProviderSupportStatus.BETA);
    expect(dropbox?.capabilities).toEqual(expect.objectContaining({ list: true, folders: true, search: true, rename: true, resumableUpload: true, quota: true }));
    expect(s3?.category).toBe(ProviderCategory.OBJECT_STORAGE);
    expect(s3?.supportStatus).toBe(ProviderSupportStatus.BETA);
    expect(s3?.capabilities).toEqual(expect.objectContaining({ list: true, multipartUpload: true, rangeDownload: true }));
    expect(r2?.supportStatus).toBe(ProviderSupportStatus.BETA);
    expect(r2?.capabilities).toEqual(expect.objectContaining({ list: true, multipartUpload: true, rangeDownload: true }));
    expect(new Set(catalog.map((entry) => entry.id)).size).toBe(catalog.length);
    expect(JSON.stringify(catalog).toLowerCase()).not.toContain('secret');
  });

  it('returns defensive copies so callers cannot mutate registered capabilities', () => {
    const first = registry.getCatalog();
    first[0].capabilities.search = false;

    expect(registry.getCatalog()[0].capabilities.search).toBe(true);
  });

  it('resolves only adapters that are registered', () => {
    expect(registry.resolve(CloudProvider.GOOGLE_DRIVE)).toBe(googleDrive);
    expect(registry.resolve(CloudProvider.ONEDRIVE)).toBe(oneDrive);
    expect(registry.resolve(CloudProvider.DROPBOX)).toBe(dropboxAdapter);
  });
});
