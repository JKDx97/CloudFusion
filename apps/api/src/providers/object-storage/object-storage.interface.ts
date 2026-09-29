import { Readable } from 'node:stream';
import { ProviderCapabilities, ProviderId } from '../common/provider-descriptor';

/** Credentials are server-side runtime values. Never return or log this object. */
export interface ObjectStorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Non-secret address of one object-storage target. */
export interface ObjectStorageTargetConfig {
  providerId: ProviderId;
  bucket: string;
  region: string;
  endpoint?: string;
  prefix?: string;
  forcePathStyle?: boolean;
}

export interface ObjectUploadInput {
  body: Readable | Buffer;
  contentLength?: number;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface ProviderObjectMetadata {
  key: string;
  size?: number;
  etag?: string;
  lastModified?: Date;
  contentType?: string;
  checksum?: string;
  metadata?: Record<string, string>;
}

export interface ProviderObjectPage {
  objects: ProviderObjectMetadata[];
  continuationToken?: string;
  isTruncated: boolean;
}

export interface ProviderConnectionTestResult {
  success: boolean;
  latencyMs: number;
  read: boolean;
  write?: boolean;
  cleanup?: boolean;
  errorCode?: string;
}

export interface ObjectStorageAdapter {
  readonly providerId: ProviderId;
  readonly capabilities: Readonly<ProviderCapabilities>;

  testConnection(verifyWrite?: boolean): Promise<ProviderConnectionTestResult>;
  putObject(key: string, input: ObjectUploadInput): Promise<ProviderObjectMetadata>;
  getObject(key: string, range?: { start: number; end?: number }): Promise<{ body: Readable; metadata: ProviderObjectMetadata }>;
  headObject(key: string): Promise<ProviderObjectMetadata>;
  deleteObject(key: string): Promise<void>;
  listObjects(options?: { prefix?: string; continuationToken?: string; maxKeys?: number }): Promise<ProviderObjectPage>;
  copyObject(sourceKey: string, destinationKey: string): Promise<ProviderObjectMetadata>;
  close(): void;
}
