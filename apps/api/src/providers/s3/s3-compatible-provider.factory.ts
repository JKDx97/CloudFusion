import { BadRequestException, Injectable } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ObjectStorageCredentials, ObjectStorageTargetConfig } from '../object-storage/object-storage.interface';
import { ProviderId } from '../common/provider-descriptor';
import { S3CompatibleProviderAdapter } from './s3-compatible-provider.adapter';

const S3_PROVIDER_IDS = new Set<ProviderId>([
  ProviderId.AWS_S3,
  ProviderId.CLOUDFLARE_R2,
  ProviderId.WASABI,
  ProviderId.BACKBLAZE_B2,
  ProviderId.DIGITALOCEAN_SPACES,
  ProviderId.ORACLE_OBJECT_STORAGE,
  ProviderId.IBM_COS,
  ProviderId.CUSTOM_S3,
]);

@Injectable()
export class S3CompatibleProviderFactory {
  async create(target: ObjectStorageTargetConfig, credentials: ObjectStorageCredentials): Promise<S3CompatibleProviderAdapter> {
    if (!S3_PROVIDER_IDS.has(target.providerId)) throw new BadRequestException('Provider is not S3-compatible');
    if (!target.bucket.trim() || !target.region.trim()) throw new BadRequestException('Bucket and region are required');
    if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new BadRequestException('S3 access credentials are required');

    const allowPrivateEndpoints = process.env.PROVIDER_CUSTOM_S3_ALLOW_PRIVATE_ENDPOINTS === 'true';
    const endpoint = target.endpoint ? await validateEndpoint(target.endpoint, allowPrivateEndpoints) : undefined;
    if (target.providerId === ProviderId.CUSTOM_S3 && !endpoint) {
      throw new BadRequestException('A custom S3 endpoint is required');
    }

    const prefix = normalizePrefix(target.prefix ?? '');
    const client = new S3Client({
      region: target.region,
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: target.forcePathStyle ?? target.providerId === ProviderId.CUSTOM_S3,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
      },
      maxAttempts: 3,
    });
    return new S3CompatibleProviderAdapter(target.providerId, target.bucket.trim(), prefix, client);
  }
}

export function normalizePrefix(prefix: string): string {
  const normalized = prefix.trim().replace(/^\/+|\/+$/g, '');
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..') || normalized.includes('\\')) {
    throw new BadRequestException('Invalid managed prefix');
  }
  return normalized ? `${normalized}/` : '';
}

async function validateEndpoint(value: string, allowPrivateEndpoints: boolean): Promise<string> {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new BadRequestException('Invalid S3 endpoint URL');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new BadRequestException('S3 endpoint must be an HTTP(S) URL without credentials, query, or fragment');
  }
  const host = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (['metadata.google.internal', 'metadata.azure.internal', '169.254.169.254', '169.254.170.2', 'fd00:ec2::254'].includes(host)) {
    throw new BadRequestException('Cloud metadata endpoints are not valid S3 endpoints');
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new BadRequestException('S3 endpoint host could not be resolved');
  }
  if (!addresses.length) throw new BadRequestException('S3 endpoint host could not be resolved');
  if (!allowPrivateEndpoints && addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new BadRequestException('Private S3 endpoints require PROVIDER_CUSTOM_S3_ALLOW_PRIVATE_ENDPOINTS=true');
  }
  return endpoint.toString().replace(/\/$/, '');
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 ||
      a === 192 && b === 0 || a === 198 && (b === 18 || b === 19 || b === 51) ||
      a === 203 && b === 0;
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
    const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return true;
}
