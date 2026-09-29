import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { CloudAccount } from './entities/cloud-account.entity';
import { CloudCredentialType } from './entities/cloud-credential-type.enum';
import { CloudAccountStatus, CloudProvider } from '../providers/common/cloud-provider.enum';
import { ProviderId, providerId } from '../providers/common/provider-descriptor';
import { ProviderConnectionTestResult, ObjectStorageCredentials, ObjectStorageTargetConfig } from '../providers/object-storage/object-storage.interface';
import { StorageTarget } from '../providers/object-storage/entities/storage-target.entity';
import { S3CompatibleProviderFactory, normalizePrefix } from '../providers/s3/s3-compatible-provider.factory';
import { TokenEncryptionService } from './services/token-encryption.service';
import { CloudAccountService, CloudAccountPublic } from './cloud-account.service';
import { AddS3TargetDto, ConnectS3AccountDto, S3_PROVIDERS, S3TargetBaseDto, S3TargetInputDto } from './dto/s3-target-input.dto';

export interface StorageTargetPublic {
  id: string;
  cloudAccountId: string;
  type: string;
  name: string;
  remoteIdentifier: string;
  region: string | null;
  endpoint: string | null;
  prefix: string;
  forcePathStyle: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface S3AccountConnectionResult {
  account: CloudAccountPublic;
  target: StorageTargetPublic;
  health: ProviderConnectionTestResult;
}

@Injectable()
export class S3CloudAccountService {
  constructor(
    @InjectRepository(CloudAccount) private readonly accounts: Repository<CloudAccount>,
    @InjectRepository(StorageTarget) private readonly targets: Repository<StorageTarget>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly encryption: TokenEncryptionService,
    private readonly s3Factory: S3CompatibleProviderFactory,
    private readonly cloudAccounts: CloudAccountService,
  ) {}

  async testConnection(input: S3TargetInputDto & Partial<Pick<ConnectS3AccountDto, 'accessKeyId' | 'secretAccessKey' | 'sessionToken'>>): Promise<ProviderConnectionTestResult> {
    if (!input.accessKeyId || !input.secretAccessKey) throw new BadRequestException('S3 access credentials are required');
    const config = this.toTargetConfig(input.provider, input);
    const credentials = this.toCredentials({
      accessKeyId: input.accessKeyId!,
      secretAccessKey: input.secretAccessKey!,
      sessionToken: input.sessionToken,
    });
    const adapter = await this.s3Factory.create(config, credentials);
    try {
      return await adapter.testConnection(input.verifyWrite === true);
    } finally {
      adapter.close();
    }
  }

  async connect(userId: string, input: ConnectS3AccountDto): Promise<S3AccountConnectionResult> {
    const health = await this.testConnection(input);
    if (!health.success || !health.read) {
      throw new BadRequestException({ code: health.errorCode ?? 'S3_CONNECTION_FAILED', health });
    }
    const providerIdValue = providerId(input.provider);
    const fingerprint = createHash('sha256').update(`${input.provider}:${input.accessKeyId}`).digest('hex');
    const credentialPayload = this.encryption.encrypt(JSON.stringify(this.toCredentials(input)));
    const targetConfig = this.toTargetConfig(input.provider, input);

    return this.dataSource.transaction(async (manager) => {
      const accounts = manager.getRepository(CloudAccount);
      const targets = manager.getRepository(StorageTarget);
      const existing = await accounts.findOne({ where: { userId, provider: input.provider, providerAccountId: fingerprint } });
      const account = existing ?? accounts.create({
        userId,
        provider: input.provider,
        providerAccountId: fingerprint,
        email: null,
        accessTokenEncrypted: '',
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        scopes: [],
        storageUsed: null,
        storageTotal: null,
        lastSyncAt: null,
      });
      account.displayName = input.accountName?.trim() || `${this.providerName(input.provider)} — ${input.bucket}`;
      account.credentialType = CloudCredentialType.ACCESS_KEY;
      account.credentialsEncrypted = credentialPayload;
      account.configurationEncrypted = null;
      account.status = health.success && health.read && health.write !== false && health.cleanup !== false
        ? CloudAccountStatus.CONNECTED
        : CloudAccountStatus.DEGRADED;
      account.lastHealthCheckAt = new Date();
      const savedAccount = await accounts.save(account);
      const target = await this.saveTarget(targets, savedAccount.id, targetConfig, input.bucket);
      return { account: this.cloudAccounts.toPublic(savedAccount), target: this.toPublicTarget(target), health };
    });
  }

  async listTargets(userId: string, accountId: string): Promise<StorageTargetPublic[]> {
    const account = await this.getOwnedAccount(userId, accountId);
    if (account.credentialType !== CloudCredentialType.ACCESS_KEY) throw new NotFoundException('Storage targets not found');
    const items = await this.targets.find({ where: { cloudAccountId: accountId }, order: { name: 'ASC' } });
    return items.map((item) => this.toPublicTarget(item));
  }

  async addTarget(userId: string, accountId: string, input: AddS3TargetDto): Promise<{ target: StorageTargetPublic; health: ProviderConnectionTestResult }> {
    const account = await this.getOwnedAccount(userId, accountId);
    if (account.credentialType !== CloudCredentialType.ACCESS_KEY || !account.credentialsEncrypted || !this.isSupportedS3Provider(account.provider)) {
      throw new NotFoundException('S3 account not found');
    }
    const config = this.toTargetConfig(account.provider, input);
    const credentials = this.decryptCredentials(account.credentialsEncrypted);
    const adapter = await this.s3Factory.create(config, credentials);
    let health: ProviderConnectionTestResult;
    try {
      health = await adapter.testConnection(input.verifyWrite === true);
    } finally {
      adapter.close();
    }
    if (!health.success || !health.read) throw new BadRequestException({ code: health.errorCode ?? 'S3_CONNECTION_FAILED', health });
    const saved = await this.saveTarget(this.targets, accountId, config, input.name?.trim() || input.bucket);
    account.lastHealthCheckAt = new Date();
    account.status = health.success && health.read && health.write !== false && health.cleanup !== false
      ? CloudAccountStatus.CONNECTED
      : CloudAccountStatus.DEGRADED;
    await this.accounts.save(account);
    return { target: this.toPublicTarget(saved), health };
  }

  async testTarget(userId: string, accountId: string, targetId: string, verifyWrite = false): Promise<ProviderConnectionTestResult> {
    const account = await this.getOwnedAccount(userId, accountId);
    if (account.credentialType !== CloudCredentialType.ACCESS_KEY || !account.credentialsEncrypted || !this.isSupportedS3Provider(account.provider)) {
      throw new NotFoundException('S3 account not found');
    }
    const target = await this.targets.findOne({ where: { id: targetId, cloudAccountId: accountId } });
    if (!target) throw new NotFoundException('Storage target not found');
    const adapter = await this.s3Factory.create(this.targetToConfig(account.provider, target), this.decryptCredentials(account.credentialsEncrypted));
    try {
      const health = await adapter.testConnection(verifyWrite);
      account.lastHealthCheckAt = new Date();
      account.status = health.success && health.read && health.write !== false && health.cleanup !== false
        ? CloudAccountStatus.CONNECTED
        : health.success && health.read
          ? CloudAccountStatus.DEGRADED
          : health.errorCode === 'PROVIDER_RATE_LIMITED'
            ? CloudAccountStatus.RATE_LIMITED
            : health.errorCode === 'PROVIDER_UNAVAILABLE'
              ? CloudAccountStatus.UNAVAILABLE
              : CloudAccountStatus.DEGRADED;
      await this.accounts.save(account);
      return health;
    } finally {
      adapter.close();
    }
  }

  private async getOwnedAccount(userId: string, accountId: string): Promise<CloudAccount> {
    const account = await this.accounts.findOne({ where: { id: accountId, userId } });
    if (!account) throw new NotFoundException('Cloud account not found');
    return account;
  }

  private async saveTarget(repository: Repository<StorageTarget>, accountId: string, config: ObjectStorageTargetConfig, name: string): Promise<StorageTarget> {
    const prefix = normalizePrefix(config.prefix ?? '');
    const existing = await repository.findOne({ where: { cloudAccountId: accountId, remoteIdentifier: config.bucket, prefix } });
    const target = existing ?? repository.create({ cloudAccountId: accountId, remoteIdentifier: config.bucket, prefix, type: 'S3_BUCKET' });
    target.name = name;
    target.region = config.region;
    target.endpoint = config.endpoint ?? null;
    target.forcePathStyle = config.forcePathStyle ?? false;
    target.enabled = true;
    return repository.save(target);
  }

  private toPublicTarget(target: StorageTarget): StorageTargetPublic {
    return {
      id: target.id,
      cloudAccountId: target.cloudAccountId,
      type: target.type,
      name: target.name,
      remoteIdentifier: target.remoteIdentifier,
      region: target.region,
      endpoint: target.endpoint,
      prefix: target.prefix,
      forcePathStyle: target.forcePathStyle,
      enabled: target.enabled,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    };
  }

  private toTargetConfig(provider: CloudProvider, input: S3TargetBaseDto): ObjectStorageTargetConfig {
    if (!this.isSupportedS3Provider(provider)) throw new BadRequestException('S3 provider is not available');
    return {
      providerId: providerId(provider),
      bucket: input.bucket.trim(),
      region: input.region.trim(),
      endpoint: input.endpoint?.trim() || undefined,
      prefix: normalizePrefix(input.prefix ?? ''),
      forcePathStyle: input.forcePathStyle,
    };
  }

  private targetToConfig(provider: CloudProvider, target: StorageTarget): ObjectStorageTargetConfig {
    return {
      providerId: providerId(provider),
      bucket: target.remoteIdentifier,
      region: target.region ?? '',
      endpoint: target.endpoint ?? undefined,
      prefix: target.prefix,
      forcePathStyle: target.forcePathStyle,
    };
  }

  private toCredentials(input: Pick<ConnectS3AccountDto, 'accessKeyId' | 'secretAccessKey' | 'sessionToken'>): ObjectStorageCredentials {
    return {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
    };
  }

  private decryptCredentials(value: string): ObjectStorageCredentials {
    try {
      const parsed = JSON.parse(this.encryption.decrypt(value)) as Partial<ObjectStorageCredentials>;
      if (typeof parsed.accessKeyId !== 'string' || typeof parsed.secretAccessKey !== 'string') throw new Error('Invalid credentials payload');
      return {
        accessKeyId: parsed.accessKeyId,
        secretAccessKey: parsed.secretAccessKey,
        ...(typeof parsed.sessionToken === 'string' ? { sessionToken: parsed.sessionToken } : {}),
      };
    } catch {
      throw new BadRequestException('Stored provider credentials are unavailable');
    }
  }

  private isSupportedS3Provider(provider: CloudProvider): boolean {
    return S3_PROVIDERS.includes(provider);
  }

  private providerName(provider: CloudProvider): string {
    const names: Partial<Record<CloudProvider, string>> = {
      [CloudProvider.AWS_S3]: 'Amazon S3',
      [CloudProvider.CLOUDFLARE_R2]: 'Cloudflare R2',
      [CloudProvider.WASABI]: 'Wasabi',
      [CloudProvider.BACKBLAZE_B2]: 'Backblaze B2',
      [CloudProvider.DIGITALOCEAN_SPACES]: 'DigitalOcean Spaces',
      [CloudProvider.ORACLE_OBJECT_STORAGE]: 'Oracle Object Storage',
      [CloudProvider.IBM_COS]: 'IBM Cloud Object Storage',
      [CloudProvider.CUSTOM_S3]: 'S3 Compatible',
    };
    return names[provider] ?? 'S3 Compatible';
  }
}
