import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ProviderCapabilities, emptyProviderCapabilities, ProviderId } from '../common/provider-descriptor';
import { ProviderErrorCode, ProviderException } from '../common/provider-error';
import {
  ObjectStorageAdapter,
  ObjectUploadInput,
  ProviderConnectionTestResult,
  ProviderObjectMetadata,
  ProviderObjectPage,
} from '../object-storage/object-storage.interface';

const MULTIPART_VERIFIED = new Set<ProviderId>([
  ProviderId.AWS_S3,
  ProviderId.CLOUDFLARE_R2,
]);

export class S3CompatibleProviderAdapter implements ObjectStorageAdapter {
  readonly capabilities: Readonly<ProviderCapabilities>;

  constructor(
    readonly providerId: ProviderId,
    private readonly bucket: string,
    private readonly managedPrefix: string,
    private readonly client: S3Client,
  ) {
    const verified = emptyProviderCapabilities();
    verified.list = true;
    verified.copy = providerId === ProviderId.AWS_S3 || providerId === ProviderId.CLOUDFLARE_R2;
    verified.serverSideCopy = providerId === ProviderId.AWS_S3 || providerId === ProviderId.CLOUDFLARE_R2;
    verified.multipartUpload = MULTIPART_VERIFIED.has(providerId);
    verified.resumableUpload = MULTIPART_VERIFIED.has(providerId);
    verified.rangeDownload = providerId === ProviderId.AWS_S3 || providerId === ProviderId.CLOUDFLARE_R2;
    this.capabilities = Object.freeze(verified);
  }

  async testConnection(verifyWrite = false): Promise<ProviderConnectionTestResult> {
    const started = Date.now();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.managedPrefix, MaxKeys: 1 }));
    } catch (error) {
      const normalized = normalizeS3Error(error, ProviderErrorCode.PROVIDER_UNAVAILABLE);
      return {
        success: false,
        latencyMs: Date.now() - started,
        read: false,
        ...(verifyWrite ? { write: false } : {}),
        errorCode: errorCode(normalized),
      };
    }
    if (!verifyWrite) return { success: true, latencyMs: Date.now() - started, read: true };

    const key = this.resolveKey(`.cloudfusion-healthcheck/${randomUUID()}`);
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: Buffer.alloc(0) }));
      try {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        return { success: true, latencyMs: Date.now() - started, read: true, write: true, cleanup: true };
      } catch {
        return { success: true, latencyMs: Date.now() - started, read: true, write: true, cleanup: false, errorCode: 'TEST_OBJECT_CLEANUP_FAILED' };
      }
    } catch (error) {
      const normalized = normalizeS3Error(error, ProviderErrorCode.PROVIDER_UNAVAILABLE);
      return { success: false, latencyMs: Date.now() - started, read: true, write: false, errorCode: errorCode(normalized) };
    }
  }

  async putObject(key: string, input: ObjectUploadInput): Promise<ProviderObjectMetadata> {
    const remoteKey = this.resolveKey(key);
    const params = {
      Bucket: this.bucket,
      Key: remoteKey,
      Body: input.body,
      ...(input.contentLength == null ? {} : { ContentLength: input.contentLength }),
      ...(input.contentType ? { ContentType: input.contentType } : {}),
      ...(input.metadata ? { Metadata: input.metadata } : {}),
    };
    try {
      let etag: string | undefined;
      if (this.capabilities.multipartUpload && input.body instanceof Readable) {
        const result = await new Upload({
          client: this.client,
          params,
          queueSize: 3,
          partSize: 8 * 1024 * 1024,
          leavePartsOnError: false,
        }).done();
        etag = result.ETag;
      } else {
        etag = (await this.client.send(new PutObjectCommand(params))).ETag;
      }
      return {
        key,
        ...(input.contentLength == null ? {} : { size: input.contentLength }),
        etag,
        contentType: input.contentType,
        metadata: input.metadata,
      };
    } catch (error) {
      throw normalizeS3Error(error, ProviderErrorCode.PROVIDER_UPLOAD_FAILED);
    }
  }

  async getObject(key: string, range?: { start: number; end?: number }): Promise<{ body: Readable; metadata: ProviderObjectMetadata }> {
    if (range && !this.capabilities.rangeDownload) {
      throw new ProviderException(ProviderErrorCode.PROVIDER_CAPABILITY_NOT_SUPPORTED, 501);
    }
    if (range && (!Number.isInteger(range.start) || range.start < 0 || range.end != null && (!Number.isInteger(range.end) || range.end < range.start))) {
      throw new TypeError('Invalid byte range');
    }
    const remoteKey = this.resolveKey(key);
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: remoteKey,
        ...(range ? { Range: `bytes=${range.start}-${range.end ?? ''}` } : {}),
      }));
      if (!response.Body) throw new ProviderException(ProviderErrorCode.PROVIDER_DOWNLOAD_FAILED, 502);
      return {
        body: Readable.from(response.Body as AsyncIterable<Uint8Array>),
        metadata: {
          key,
          size: Number(response.ContentLength ?? 0),
          etag: response.ETag,
          lastModified: response.LastModified,
          contentType: response.ContentType,
          checksum: response.ChecksumSHA256,
          metadata: response.Metadata,
        },
      };
    } catch (error) {
      throw normalizeS3Error(error, ProviderErrorCode.PROVIDER_DOWNLOAD_FAILED);
    }
  }

  async headObject(key: string): Promise<ProviderObjectMetadata> {
    return this.headRemoteObject(this.resolveKey(key), key);
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.resolveKey(key) }));
    } catch (error) {
      throw normalizeS3Error(error, ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND);
    }
  }

  async listObjects(options: { prefix?: string; continuationToken?: string; maxKeys?: number } = {}): Promise<ProviderObjectPage> {
    const maxKeys = options.maxKeys ?? 1000;
    if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1000) throw new RangeError('maxKeys must be between 1 and 1000');
    const queryPrefix = options.prefix ? this.resolveKey(options.prefix) : this.managedPrefix;
    try {
      const result = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: queryPrefix,
        ContinuationToken: options.continuationToken,
        MaxKeys: maxKeys,
      }));
      return {
        objects: (result.Contents ?? []).flatMap((item) => item.Key?.startsWith(this.managedPrefix) ? [{
          key: item.Key.slice(this.managedPrefix.length),
          size: Number(item.Size ?? 0),
          etag: item.ETag,
          lastModified: item.LastModified,
        }] : []),
        continuationToken: result.NextContinuationToken,
        isTruncated: result.IsTruncated ?? false,
      };
    } catch (error) {
      throw normalizeS3Error(error, ProviderErrorCode.PROVIDER_UNAVAILABLE);
    }
  }

  async copyObject(sourceKey: string, destinationKey: string): Promise<ProviderObjectMetadata> {
    if (!this.capabilities.serverSideCopy) {
      throw new ProviderException(ProviderErrorCode.PROVIDER_CAPABILITY_NOT_SUPPORTED, 501);
    }
    const source = this.resolveKey(sourceKey);
    const destination = this.resolveKey(destinationKey);
    try {
      const result = await this.client.send(new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destination,
        CopySource: `/${this.bucket}/${source.split('/').map(encodeURIComponent).join('/')}`,
      }));
      return { key: destinationKey, etag: result.CopyObjectResult?.ETag };
    } catch (error) {
      throw normalizeS3Error(error, ProviderErrorCode.PROVIDER_UNAVAILABLE);
    }
  }

  close(): void {
    this.client.destroy();
  }

  private async headRemoteObject(remoteKey: string, publicKey = remoteKey.slice(this.managedPrefix.length)): Promise<ProviderObjectMetadata> {
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: remoteKey }));
      return {
        key: publicKey,
        size: Number(response.ContentLength ?? 0),
        etag: response.ETag,
        lastModified: response.LastModified,
        contentType: response.ContentType,
        checksum: response.ChecksumSHA256,
        metadata: response.Metadata,
      };
    } catch (error) {
      throw normalizeS3Error(error, ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND);
    }
  }

  private resolveKey(key: string): string {
    if (!key || key.startsWith('/') || key.includes('\\') || /[\u0000-\u001f]/.test(key) || key.split('/').some((part) => part === '.' || part === '..')) {
      throw new TypeError('Invalid object key');
    }
    return `${this.managedPrefix}${key}`;
  }
}

function normalizeS3Error(error: unknown, fallback: ProviderErrorCode): ProviderException {
  const value = error && typeof error === 'object' ? error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } : {};
  const name = value.name ?? value.Code ?? '';
  const status = value.$metadata?.httpStatusCode;
  if (['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'InvalidToken'].includes(name) || status === 401) {
    return new ProviderException(ProviderErrorCode.PROVIDER_AUTH_FAILED, 401);
  }
  if (name === 'AccessDenied' || status === 403) return new ProviderException(ProviderErrorCode.PROVIDER_PERMISSION_DENIED, 403);
  if (['SlowDown', 'Throttling', 'ThrottlingException', 'TooManyRequestsException'].includes(name) || status === 429) {
    return new ProviderException(ProviderErrorCode.PROVIDER_RATE_LIMITED, 429);
  }
  if (name === 'NoSuchBucket' || name === 'NotFound' && fallback === ProviderErrorCode.PROVIDER_UNAVAILABLE) {
    return new ProviderException(ProviderErrorCode.PROVIDER_TARGET_NOT_FOUND, 404);
  }
  if (['NoSuchKey', 'NoSuchVersion'].includes(name) || name === 'NotFound' && [ProviderErrorCode.PROVIDER_DOWNLOAD_FAILED, ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND].includes(fallback) || status === 404 && [ProviderErrorCode.PROVIDER_DOWNLOAD_FAILED, ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND].includes(fallback)) {
    return new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
  }
  if (['NotImplemented', 'NotSupported'].includes(name) || status === 501) {
    return new ProviderException(ProviderErrorCode.PROVIDER_CAPABILITY_NOT_SUPPORTED, 501);
  }
  if (['QuotaExceeded', 'StorageQuotaExceeded'].includes(name)) {
    return new ProviderException(ProviderErrorCode.PROVIDER_QUOTA_EXCEEDED, 507);
  }
  return new ProviderException(fallback, status && status >= 500 ? status : 502);
}

function errorCode(error: ProviderException): string {
  const response = error.getResponse();
  return typeof response === 'object' && response && 'code' in response ? String(response.code) : ProviderErrorCode.PROVIDER_UNAVAILABLE;
}
