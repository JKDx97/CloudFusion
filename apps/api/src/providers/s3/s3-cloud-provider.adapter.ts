import { BadRequestException } from '@nestjs/common';
import { StorageTarget } from '../object-storage/entities/storage-target.entity';
import { ObjectStorageCredentials, ObjectStorageTargetConfig } from '../object-storage/object-storage.interface';
import { CloudAccountInfo, CloudDownload, CloudFile, CloudQuota } from '../common/cloud-file.interface';
import { CloudProvider } from '../common/cloud-provider.enum';
import { providerId } from '../common/provider-descriptor';
import { CloudProviderAdapter, ProviderTokenSet, ProviderUploadInput } from '../common/cloud-provider.interface';
import { ProviderErrorCode, ProviderException } from '../common/provider-error';
import { S3CompatibleProviderFactory, normalizePrefix } from './s3-compatible-provider.factory';
import { S3CompatibleProviderAdapter } from './s3-compatible-provider.adapter';

const FILE_ID_PREFIX = 'cf-s3:';
const LIST_PAGE_SIZE = 1000;
const SIMPLE_FILE_NAME_PATTERN = /[\\/\u0000-\u001f]/;

/** Binds encrypted CloudAccount credentials and StorageTargets to the regular file adapter interface. */
export class S3CloudProviderAdapter implements CloudProviderAdapter {
  constructor(
    readonly provider: CloudProvider,
    private readonly accountId: string,
    private readonly credentials: ObjectStorageCredentials,
    private readonly targets: StorageTarget[],
    private readonly factory: S3CompatibleProviderFactory,
  ) {
    if (!targets.length) throw new ProviderException(ProviderErrorCode.PROVIDER_TARGET_NOT_FOUND, 404);
  }

  getAuthorizationUrl(_state: string): string {
    throw unsupported();
  }
  async exchangeAuthorizationCode(_code: string): Promise<{ account: CloudAccountInfo; tokens: ProviderTokenSet }> {
    throw unsupported();
  }
  async refreshAccessToken(_refreshToken: string): Promise<ProviderTokenSet> {
    throw unsupported();
  }
  async revokeAuthorization(_refreshToken: string): Promise<void> {
    throw unsupported();
  }

  async listFiles(_accessToken: string, accountId: string, parentId?: string): Promise<CloudFile[]> {
    this.assertAccount(accountId);
    if (parentId) {
      const parent = this.parseId(parentId);
      if (parent.kind !== 'folder') throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
      const target = this.requireTarget(parent.targetId);
      return this.withTarget(target, (adapter) => this.listChildren(adapter, target, parent.key));
    }
    return this.targets.map((target) => this.targetRoot(target));
  }

  async searchFiles(): Promise<CloudFile[]> {
    throw unsupported();
  }

  async getFile(_accessToken: string, accountId: string, fileId: string): Promise<CloudFile> {
    this.assertAccount(accountId);
    const parsed = this.parseId(fileId);
    const target = this.requireTarget(parsed.targetId);
    if (parsed.kind === 'folder' && !parsed.key) return this.targetRoot(target);
    return this.withTarget(target, async (adapter) => {
      if (parsed.kind === 'folder') {
        const folderKey = `${parsed.key.replace(/\/$/, '')}/`;
        try {
          await adapter.headObject(folderKey);
          return this.folder(target, parsed.key, parentKey(parsed.key));
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        const page = await adapter.listObjects({
          prefix: folderKey,
          maxKeys: 1,
        });
        if (!page.objects.length) throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
        return this.folder(target, parsed.key, parentKey(parsed.key));
      }
      try {
        const metadata = await adapter.headObject(parsed.key);
        return this.objectFile(target, metadata);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
    });
  }

  async uploadFile(_accessToken: string, accountId: string, input: ProviderUploadInput): Promise<CloudFile> {
    this.assertAccount(accountId);
    this.assertName(input.name);
    const { target, key: parentKey } = this.parentForWrite(input.parentId);
    const key = joinKey(parentKey, input.name);
    return this.withTarget(target, async (adapter) => {
      const result = await adapter.putObject(key, {
        body: input.stream,
        contentLength: input.size,
        contentType: input.mimeType,
      });
      return {
        id: this.encodeId(target.id, key, 'file'),
        provider: this.provider,
        accountId,
        name: input.name,
        mimeType: input.mimeType ?? 'application/octet-stream',
        type: 'file',
        ...(input.size == null ? {} : { size: input.size }),
        parentId: this.encodeId(target.id, parentKey, 'folder'),
        ...(result.lastModified ? { modifiedAt: result.lastModified.toISOString() } : {}),
      };
    });
  }

  async downloadFile(_accessToken: string, accountId: string, fileId: string): Promise<CloudDownload> {
    this.assertAccount(accountId);
    const parsed = this.parseId(fileId);
    if (parsed.kind !== 'file') throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
    const target = this.requireTarget(parsed.targetId);
    const adapter = await this.openTarget(target);
    try {
      const result = await adapter.getObject(parsed.key);
      result.body.once('close', () => adapter.close());
      result.body.once('error', () => adapter.close());
      return {
        stream: result.body,
        fileName: parsed.key.split('/').pop() ?? parsed.key,
        mimeType: result.metadata.contentType ?? 'application/octet-stream',
        ...(result.metadata.size == null ? {} : { size: result.metadata.size }),
      };
    } catch (error) {
      adapter.close();
      throw error;
    }
  }

  async createFolder(_accessToken: string, accountId: string, name: string, parentId?: string): Promise<CloudFile> {
    this.assertAccount(accountId);
    this.assertName(name);
    const { target, key: parentKey } = this.parentForWrite(parentId);
    const folderKey = `${joinKey(parentKey, name)}/`;
    return this.withTarget(target, async (adapter) => {
      await adapter.putObject(folderKey, {
        body: Buffer.alloc(0),
        contentLength: 0,
        contentType: 'application/x-directory',
      });
      return this.folder(target, folderKey.slice(0, -1));
    });
  }

  async renameItem(_accessToken: string, accountId: string, fileId: string, name: string): Promise<CloudFile> {
    this.assertAccount(accountId);
    this.assertName(name);
    const parsed = this.parseId(fileId);
    const target = this.requireTarget(parsed.targetId);
    if (parsed.kind !== 'file') throw unsupported();
    return this.withTarget(target, async (adapter) => {
      if (!adapter.capabilities.serverSideCopy) throw unsupported();
      const source = await adapter.headObject(parsed.key);
      const newKey = joinKey(parentKey(parsed.key), name);
      if (newKey === parsed.key) return this.objectFile(target, source);
      try {
        await adapter.headObject(newKey);
        throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_ALREADY_EXISTS, 409);
      } catch (error) {
        if (error instanceof ProviderException && error.getStatus() === 409) throw error;
        if (!isNotFound(error)) throw error;
      }
      await adapter.copyObject(parsed.key, newKey);
      try {
        await adapter.deleteObject(parsed.key);
      } catch {
        throw new ProviderException(ProviderErrorCode.MOVE_SOURCE_DELETE_FAILED, 502);
      }
      return this.objectFile(target, { ...source, key: newKey });
    });
  }

  async deleteItem(_accessToken: string, accountId: string, fileId: string): Promise<void> {
    this.assertAccount(accountId);
    const parsed = this.parseId(fileId);
    const target = this.requireTarget(parsed.targetId);
    if (parsed.kind === 'folder' && !parsed.key) throw unsupported();
    return this.withTarget(target, async (adapter) => {
      if (parsed.kind === 'file') {
        await adapter.deleteObject(parsed.key);
        return;
      }
      const directoryPrefix = `${parsed.key.replace(/\/$/, '')}/`;
      let remaining: number;
      do {
        const page = await adapter.listObjects({
          prefix: directoryPrefix,
          maxKeys: LIST_PAGE_SIZE,
        });
        remaining = page.objects.length;
        for (const object of page.objects) await adapter.deleteObject(object.key);
      } while (remaining === LIST_PAGE_SIZE);
      await adapter.deleteObject(directoryPrefix).catch(() => undefined);
    });
  }

  async getStorageQuota(): Promise<CloudQuota> {
    throw unsupported();
  }

  private async listChildren(adapter: S3CompatibleProviderAdapter, target: StorageTarget, parentKey: string): Promise<CloudFile[]> {
    const prefix = parentKey ? `${parentKey.replace(/\/$/, '')}/` : '';
    const files = new Map<string, CloudFile>();
    let continuationToken: string | undefined;
    do {
      const page = await adapter.listObjects({
        ...(prefix ? { prefix } : {}),
        delimiter: '/',
        continuationToken,
        maxKeys: LIST_PAGE_SIZE,
      });
      for (const folderPrefix of page.commonPrefixes ?? []) {
        const folderKey = folderPrefix.replace(/\/$/, '');
        if (folderKey && folderKey !== parentKey) files.set(folderKey, this.folder(target, folderKey, parentKey));
      }
      for (const object of page.objects) {
        if (!object.key.startsWith(prefix)) continue;
        const relative = object.key.slice(prefix.length);
        if (!relative) continue;
        if (relative.endsWith('/')) {
          const folderKey = joinKey(parentKey, relative.slice(0, -1));
          files.set(folderKey, this.folder(target, folderKey, parentKey));
        } else if (!relative.includes('/')) {
          files.set(object.key, this.objectFile(target, object, parentKey));
        }
      }
      continuationToken = page.isTruncated ? page.continuationToken : undefined;
    } while (continuationToken);
    return [...files.values()];
  }

  private objectFile(
    target: StorageTarget,
    metadata: {
      key: string;
      size?: number;
      contentType?: string;
      lastModified?: Date;
    },
    parent?: string,
  ): CloudFile {
    const key = metadata.key.replace(/\/$/, '');
    const segments = key.split('/');
    return {
      id: this.encodeId(target.id, key, 'file'),
      provider: this.provider,
      accountId: this.accountId,
      name: segments[segments.length - 1],
      mimeType: metadata.contentType ?? 'application/octet-stream',
      type: 'file',
      ...(metadata.size == null ? {} : { size: metadata.size }),
      parentId: this.encodeId(target.id, parent ?? parentKey(key), 'folder'),
      ...(metadata.lastModified ? { modifiedAt: metadata.lastModified.toISOString() } : {}),
    };
  }

  private folder(target: StorageTarget, key: string, parent?: string): CloudFile {
    const parts = key.split('/');
    return {
      id: this.encodeId(target.id, key, 'folder'),
      provider: this.provider,
      accountId: this.accountId,
      name: parts[parts.length - 1] || target.name,
      mimeType: 'application/vnd.cloudfusion.s3-folder',
      type: 'folder',
      parentId: this.encodeId(target.id, parent ?? parentKey(key), 'folder'),
    };
  }

  private targetRoot(target: StorageTarget): CloudFile {
    const { parentId: _parentId, ...root } = this.folder(target, '', '');
    return { ...root, name: target.name };
  }

  private parentForWrite(parentId?: string): {
    target: StorageTarget;
    key: string;
  } {
    if (!parentId) return { target: this.targets[0], key: '' };
    const parsed = this.parseId(parentId);
    if (parsed.kind !== 'folder') throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
    return {
      target: this.requireTarget(parsed.targetId),
      key: parsed.key.replace(/\/$/, ''),
    };
  }

  private encodeId(targetId: string, key: string, kind: 'file' | 'folder'): string {
    return `${FILE_ID_PREFIX}${targetId}:${kind}:${Buffer.from(key, 'utf8').toString('base64url')}`;
  }

  private parseId(value: string): {
    targetId: string;
    key: string;
    kind: 'file' | 'folder';
  } {
    if (!value.startsWith(FILE_ID_PREFIX)) throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
    const split = value.indexOf(':', FILE_ID_PREFIX.length);
    if (split < 0) throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
    const targetId = value.slice(FILE_ID_PREFIX.length, split);
    const kindSplit = value.indexOf(':', split + 1);
    if (kindSplit < 0) throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
    const kind = value.slice(split + 1, kindSplit);
    if (kind !== 'file' && kind !== 'folder') throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
    const encodedKey = value.slice(kindSplit + 1);
    try {
      const key = Buffer.from(encodedKey, 'base64url').toString('utf8');
      if (Buffer.from(key, 'utf8').toString('base64url') !== encodedKey || key.startsWith('/') || key.includes('\\') || /[\u0000-\u001f]/.test(key) || key.split('/').some((part) => part === '.' || part === '..')) {
        throw new Error('Invalid provider object id');
      }
      return { targetId, key, kind };
    } catch {
      throw new ProviderException(ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND, 404);
    }
  }

  private requireTarget(id: string): StorageTarget {
    const target = this.targets.find((item) => item.id === id && item.enabled);
    if (!target) throw new ProviderException(ProviderErrorCode.PROVIDER_TARGET_NOT_FOUND, 404);
    return target;
  }

  private async withTarget<T>(target: StorageTarget, operation: (adapter: S3CompatibleProviderAdapter) => Promise<T>): Promise<T> {
    const adapter = await this.openTarget(target);
    try {
      return await operation(adapter);
    } finally {
      adapter.close();
    }
  }

  private openTarget(target: StorageTarget): Promise<S3CompatibleProviderAdapter> {
    if (target.type === 'DEVICE' || !target.remoteIdentifier) {
      throw new ProviderException(ProviderErrorCode.PROVIDER_TARGET_NOT_FOUND, 404);
    }
    const config: ObjectStorageTargetConfig = {
      providerId: providerId(this.provider),
      bucket: target.remoteIdentifier,
      region: target.region ?? '',
      ...(target.endpoint ? { endpoint: target.endpoint } : {}),
      prefix: normalizePrefix(target.prefix),
      forcePathStyle: target.forcePathStyle,
    };
    return this.factory.create(config, this.credentials);
  }

  private assertAccount(accountId: string): void {
    if (accountId !== this.accountId) throw new ProviderException(ProviderErrorCode.ACCOUNT_NOT_FOUND, 404);
  }

  private assertName(name: string): void {
    if (!name.trim() || name === '.' || name === '..' || name.endsWith(' ') || SIMPLE_FILE_NAME_PATTERN.test(name)) {
      throw new BadRequestException('Object name is invalid');
    }
  }
}

function parentKey(key: string): string {
  const index = key.lastIndexOf('/');
  return index < 0 ? '' : key.slice(0, index);
}

function joinKey(parent: string, name: string): string {
  return parent ? `${parent.replace(/\/$/, '')}/${name}` : name;
}

function isNotFound(error: unknown): boolean {
  if (error instanceof ProviderException) return error.getStatus() === 404;
  if (typeof error !== 'object' || error === null) return false;
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: unknown;
  };
  return (
    value.status === 404 || value.statusCode === 404 || (typeof value.response === 'object' && value.response !== null && 'code' in value.response && value.response.code === ProviderErrorCode.PROVIDER_OBJECT_NOT_FOUND)
  );
}

function unsupported(): ProviderException {
  return new ProviderException(ProviderErrorCode.PROVIDER_CAPABILITY_NOT_SUPPORTED, 501);
}
