import { Readable } from 'node:stream';
import { StorageTarget } from '../object-storage/entities/storage-target.entity';
import { CloudProvider } from '../common/cloud-provider.enum';
import { ProviderErrorCode, ProviderException } from '../common/provider-error';
import { S3CompatibleProviderAdapter } from './s3-compatible-provider.adapter';
import { S3CompatibleProviderFactory } from './s3-compatible-provider.factory';
import { S3CloudProviderAdapter } from './s3-cloud-provider.adapter';

describe('S3CloudProviderAdapter', () => {
  const firstTarget = target('target-a', 'Primary bucket');
  const secondTarget = target('target-b', 'Archive bucket');
  let factory: jest.Mocked<S3CompatibleProviderFactory>;
  let s3: jest.Mocked<S3CompatibleProviderAdapter>;
  let adapter: S3CloudProviderAdapter;

  beforeEach(() => {
    s3 = {
      capabilities: { serverSideCopy: true },
      listObjects: jest.fn().mockResolvedValue({ objects: [], isTruncated: false }),
      putObject: jest.fn().mockResolvedValue({ key: 'uploaded.txt' }),
      headObject: jest.fn().mockResolvedValue({ key: 'source.txt', size: 7, contentType: 'text/plain' }),
      getObject: jest.fn().mockResolvedValue({ body: Readable.from('contents'), metadata: { key: 'source.txt', size: 8 } }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      copyObject: jest.fn().mockResolvedValue({ key: 'renamed.txt' }),
      close: jest.fn(),
    } as unknown as jest.Mocked<S3CompatibleProviderAdapter>;
    factory = { create: jest.fn().mockResolvedValue(s3) } as unknown as jest.Mocked<S3CompatibleProviderFactory>;
    adapter = new S3CloudProviderAdapter(CloudProvider.AWS_S3, 'account-a', {
      accessKeyId: 'access', secretAccessKey: 'never-return-this',
    }, [firstTarget, secondTarget], factory);
  });

  it('exposes enabled targets as distinct virtual roots instead of merging bucket contents', async () => {
    const roots = await adapter.listFiles('', 'account-a');

    expect(roots.map(({ name, type }) => [name, type])).toEqual([
      ['Primary bucket', 'folder'],
      ['Archive bucket', 'folder'],
    ]);
    expect(roots[0].parentId).toBeUndefined();
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('lists direct files and synthesized child folders within only the selected target', async () => {
    s3.listObjects.mockResolvedValueOnce({
      objects: [{ key: 'readme.txt', size: 9, contentType: 'text/plain' }],
      commonPrefixes: ['docs/'],
      isTruncated: false,
    });
    const [root] = await adapter.listFiles('', 'account-a');

    const items = await adapter.listFiles('', 'account-a', root.id);

    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'bucket-target-a' }), expect.any(Object));
    expect(s3.listObjects).toHaveBeenCalledWith({ prefix: undefined, delimiter: '/', continuationToken: undefined, maxKeys: 1000 });
    expect(items.map(({ name, type }) => [name, type])).toEqual([['docs', 'folder'], ['readme.txt', 'file']]);
    expect(items.find((item) => item.name === 'docs')?.parentId).toBe(root.id);
    expect(s3.close).toHaveBeenCalledTimes(1);
  });

  it('uploads into the bucket selected by a virtual-root parent id', async () => {
    const [, archiveRoot] = await adapter.listFiles('', 'account-a');

    await adapter.uploadFile('', 'account-a', {
      stream: Readable.from('data'), name: 'notes.txt', size: 4, parentId: archiveRoot.id,
    });

    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'bucket-target-b' }), expect.any(Object));
    expect(s3.putObject).toHaveBeenCalledWith('notes.txt', expect.objectContaining({ contentLength: 4 }));
  });

  it('rejects foreign accounts and does not open an S3 client', async () => {
    await expect(adapter.listFiles('', 'account-b')).rejects.toMatchObject({ response: { code: ProviderErrorCode.ACCOUNT_NOT_FOUND } });
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('deletes folder contents by draining the first page after each deletion', async () => {
    s3.listObjects
      .mockResolvedValueOnce({ objects: [{ key: 'docs/a.txt' }, { key: 'docs/b.txt' }], isTruncated: false })
      .mockResolvedValueOnce({ objects: [], isTruncated: false });
    const [root] = await adapter.listFiles('', 'account-a');
    const folder = await adapter.createFolder('', 'account-a', 'docs', root.id);

    await adapter.deleteItem('', 'account-a', folder.id);

    expect(s3.deleteObject).toHaveBeenCalledWith('docs/a.txt');
    expect(s3.deleteObject).toHaveBeenCalledWith('docs/b.txt');
    expect(s3.deleteObject).toHaveBeenCalledWith('docs/');
    expect(s3.close).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite an existing destination while renaming an S3 object', async () => {
    const file = await adapter.uploadFile('', 'account-a', { stream: Readable.from('x'), name: 'source.txt' });
    s3.headObject.mockImplementation(async (key: string) => {
      if (key === 'destination.txt') throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
      if (key === 'occupied.txt') return { key, size: 2 };
      return { key, size: 7, contentType: 'text/plain' };
    });

    await expect(adapter.renameItem('', 'account-a', file.id, 'occupied.txt')).rejects.toMatchObject({
      response: { code: ProviderErrorCode.PROVIDER_OBJECT_ALREADY_EXISTS },
      status: 409,
    });
    expect(s3.copyObject).not.toHaveBeenCalled();
    await expect(adapter.renameItem('', 'account-a', file.id, 'destination.txt')).resolves.toMatchObject({
      name: 'destination.txt', size: 7, mimeType: 'text/plain',
    });
  });

  it('does not claim search or quota support for object storage', async () => {
    await expect(adapter.searchFiles('', 'account-a', 'query')).rejects.toMatchObject({ response: { code: ProviderErrorCode.PROVIDER_CAPABILITY_NOT_SUPPORTED } });
    await expect(adapter.getStorageQuota('', 'account-a')).rejects.toMatchObject({ response: { code: ProviderErrorCode.PROVIDER_CAPABILITY_NOT_SUPPORTED } });
  });
});

function target(id: string, name: string): StorageTarget {
  return Object.assign(new StorageTarget(), {
    id,
    cloudAccountId: 'account-a',
    type: 'S3_BUCKET',
    name,
    remoteIdentifier: `bucket-${id}`,
    region: 'us-east-1',
    endpoint: null,
    prefix: '',
    forcePathStyle: false,
    enabled: true,
  });
}
