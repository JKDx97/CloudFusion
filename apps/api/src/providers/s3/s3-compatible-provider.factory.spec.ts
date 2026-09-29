import { lookup } from 'node:dns/promises';
import { ProviderId } from '../common/provider-descriptor';
import { S3CompatibleProviderFactory, normalizePrefix } from './s3-compatible-provider.factory';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

describe('S3CompatibleProviderFactory', () => {
  const factory = new S3CompatibleProviderFactory();
  const target = { providerId: ProviderId.CUSTOM_S3, bucket: 'bucket-a', region: 'us-east-1', endpoint: 'https://s3.example.test' };
  const credentials = { accessKeyId: 'test-access', secretAccessKey: 'test-secret' };
  const dnsLookup = lookup as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  it('requires a custom endpoint and credentials before constructing a client', async () => {
    await expect(factory.create({ ...target, endpoint: undefined }, credentials)).rejects.toThrow('A custom S3 endpoint is required');
    await expect(factory.create(target, { accessKeyId: 'id', secretAccessKey: '' })).rejects.toThrow('S3 access credentials are required');
  });

  it('rejects malformed, cloud metadata, and private network endpoints by default', async () => {
    await expect(factory.create({ ...target, endpoint: 'file:///etc/passwd' }, credentials)).rejects.toThrow('HTTP(S)');
    await expect(factory.create({ ...target, endpoint: 'http://169.254.169.254' }, credentials)).rejects.toThrow('metadata');
    dnsLookup.mockResolvedValueOnce([{ address: '192.168.1.30', family: 4 }]);
    await expect(factory.create(target, credentials)).rejects.toThrow('PROVIDER_CUSTOM_S3_ALLOW_PRIVATE_ENDPOINTS=true');
  });

  it('normalizes and confines a managed prefix', () => {
    expect(normalizePrefix('/cloudfusion/objects/')).toBe('cloudfusion/objects/');
    expect(() => normalizePrefix('cloudfusion/../outside')).toThrow('Invalid managed prefix');
  });

  it('creates adapter metadata without exposing supplied credentials', async () => {
    const adapter = await factory.create(target, credentials);
    expect(adapter.providerId).toBe(ProviderId.CUSTOM_S3);
    expect(adapter.capabilities.multipartUpload).toBe(false);
    expect(JSON.stringify({ providerId: adapter.providerId, capabilities: adapter.capabilities })).not.toContain('test-secret');
    adapter.close();
  });
});
