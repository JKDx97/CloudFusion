import { CopyObjectCommand, DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { ProviderErrorCode } from '../common/provider-error';
import { ProviderId } from '../common/provider-descriptor';
import { S3CompatibleProviderAdapter } from './s3-compatible-provider.adapter';

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(() => ({ done: jest.fn().mockResolvedValue({ ETag: 'multipart-etag' }) })),
}));

describe('S3CompatibleProviderAdapter', () => {
  const create = (providerId = ProviderId.AWS_S3, send = jest.fn(), prefix = 'cloudfusion/') => {
    const client = { send, destroy: jest.fn() } as unknown as S3Client;
    return { adapter: new S3CompatibleProviderAdapter(providerId, 'bucket-a', prefix, client), send, client };
  };

  beforeEach(() => jest.clearAllMocks());

  it('tests bucket/list access without writing or deleting user data by default', async () => {
    const { adapter, send } = create();
    const result = await adapter.testConnection();

    expect(result).toMatchObject({ success: true, read: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(ListObjectsV2Command);
    expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand || command instanceof DeleteObjectCommand)).toBe(false);
  });

  it('only creates a scoped temporary object when write verification is explicitly requested', async () => {
    const { adapter, send } = create();
    const result = await adapter.testConnection(true);
    const put = send.mock.calls.find(([command]) => command instanceof PutObjectCommand)?.[0] as PutObjectCommand;

    expect(result).toMatchObject({ success: true, read: true, write: true, cleanup: true });
    expect(put.input.Key).toMatch(/^cloudfusion\/\.cloudfusion-healthcheck\//);
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(true);
  });

  it('limits every listing to its configured managed prefix', async () => {
    const send = jest.fn().mockResolvedValue({
      Contents: [{ Key: 'cloudfusion/docs/report.pdf', Size: 123 }],
      IsTruncated: true,
      NextContinuationToken: 'next-page',
    });
    const { adapter } = create(ProviderId.AWS_S3, send);
    const result = await adapter.listObjects({ prefix: 'docs/', continuationToken: 'previous', maxKeys: 20 });
    const command = send.mock.calls[0][0] as ListObjectsV2Command;

    expect(command.input).toMatchObject({ Bucket: 'bucket-a', Prefix: 'cloudfusion/docs/', ContinuationToken: 'previous', MaxKeys: 20 });
    expect(result).toEqual({
      objects: [{ key: 'docs/report.pdf', size: 123, etag: undefined, lastModified: undefined }],
      continuationToken: 'next-page',
      isTruncated: true,
    });
  });

  it('rejects traversal keys and enforces conservative custom-S3 capabilities', async () => {
    const { adapter, send } = create(ProviderId.CUSTOM_S3);
    await expect(adapter.putObject('../outside', { body: Buffer.from('x') })).rejects.toThrow('Invalid object key');
    await expect(adapter.getObject('file.bin', { start: 0, end: 10 })).rejects.toThrow(ProviderErrorCode.PROVIDER_CAPABILITY_NOT_SUPPORTED);
    expect(send).not.toHaveBeenCalled();
  });

  it('uses multipart streaming for verified AWS targets and maps missing objects safely', async () => {
    const { adapter, send } = create();
    const uploaded = await adapter.putObject('big.bin', { body: Readable.from([Buffer.from('chunk')]), contentLength: 5 });

    expect(Upload).toHaveBeenCalledTimes(1);
    expect(uploaded).toMatchObject({ key: 'big.bin', size: 5, etag: 'multipart-etag' });

    const missing = Object.assign(new Error('private provider detail'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    send.mockRejectedValueOnce(missing);
    await expect(adapter.headObject('missing.bin')).rejects.toThrow(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND);
  });

  it('refuses server-side copy unless the provider capability is declared', async () => {
    const { adapter, send } = create(ProviderId.CUSTOM_S3);
    await expect(adapter.copyObject('a.txt', 'b.txt')).rejects.toThrow(ProviderErrorCode.PROVIDER_CAPABILITY_NOT_SUPPORTED);
    expect(send).not.toHaveBeenCalled();
  });

  it('declares only the R2 S3 operations confirmed by its compatibility contract', () => {
    const { adapter } = create(ProviderId.CLOUDFLARE_R2);
    expect(adapter.capabilities).toMatchObject({ list: true, multipartUpload: true, rangeDownload: true, serverSideCopy: true });
  });
});
