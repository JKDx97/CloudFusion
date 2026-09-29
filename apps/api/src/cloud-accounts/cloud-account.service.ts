import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CloudAccount } from './entities/cloud-account.entity';
import { CloudCredentialType } from './entities/cloud-credential-type.enum';
import { CloudAccountStatus, CloudProvider } from '../providers/common/cloud-provider.enum';
import { CloudProviderResolver } from '../providers/common/cloud-provider-resolver.service';
import { CloudProviderAdapter, ProviderOAuthCallbackContext, ProviderTokenSet } from '../providers/common/cloud-provider.interface';
import { ProviderException, ProviderErrorCode, providerHttpError } from '../providers/common/provider-error';
import { OAuthStateService } from './services/oauth-state.service';
import { TokenEncryptionService } from './services/token-encryption.service';
import { AccountImpactService, CloudAccountImpact } from './account-impact.service';
import { S3CloudProviderAdapterFactory } from '../providers/s3/s3-cloud-provider-adapter.factory';

export interface CloudAccountPublic {
  id: string;
  provider: CloudProvider;
  credentialType: CloudCredentialType;
  email: string | null;
  displayName: string | null;
  status: CloudAccountStatus;
  storage: { used: number; total: number | null };
  scopes: string[];
  lastSyncAt: Date | null;
  lastHealthCheckAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthorizedCloudAccount {
  account: CloudAccount;
  adapter: CloudProviderAdapter;
  accessToken: string;
}

@Injectable()
export class CloudAccountService {
  private readonly logger = new Logger(CloudAccountService.name);

  constructor(
    @InjectRepository(CloudAccount)
    private readonly repository: Repository<CloudAccount>,
    private readonly resolver: CloudProviderResolver,
    private readonly stateService: OAuthStateService,
    private readonly encryption: TokenEncryptionService,
    @Optional() private readonly impact?: AccountImpactService,
    @Optional() private readonly s3ProviderFactory?: S3CloudProviderAdapterFactory,
  ) {}

  async list(userId: string): Promise<CloudAccountPublic[]> {
    const accounts = await this.repository.find({ where: { userId }, order: { createdAt: 'ASC' } });
    return accounts.map((account) => this.toPublic(account));
  }

  async getStorageSummary(userId: string) {
    const accounts = await this.repository.find({ where: { userId }, order: { createdAt: 'ASC' } });
    await Promise.allSettled(
      accounts
        .filter(
          (account) =>
            account.status === CloudAccountStatus.CONNECTED &&
            (account.credentialType ?? CloudCredentialType.OAUTH2) === CloudCredentialType.OAUTH2 &&
            (!account.lastSyncAt || Date.now() - account.lastSyncAt.getTime() > 60_000),
        )
        .map(async (account) => {
          const context = await this.getAuthorizedAccount(userId, account.id);
          const quota = await context.adapter.getStorageQuota(context.accessToken, account.id);
          await this.updateQuota(account, quota);
        }),
    );
    const current = await this.repository.find({ where: { userId }, order: { createdAt: 'ASC' } });
    const items = current.map((account) => this.toPublic(account));
    return {
      accounts: items,
      total: {
        used: items.reduce((sum, account) => sum + account.storage.used, 0),
        total: items.every((account) => account.storage.total != null)
          ? items.reduce((sum, account) => sum + (account.storage.total ?? 0), 0)
          : null,
      },
    };
  }

  async getOwnedAccount(userId: string, accountId: string): Promise<CloudAccount> {
    const account = await this.repository.findOne({ where: { id: accountId, userId } });
    if (!account) throw new NotFoundException(ProviderErrorCode.ACCOUNT_NOT_FOUND);
    return account;
  }

  beginConnection(userId: string, provider: CloudProvider): string {
    const state = this.stateService.create(userId, provider);
    return this.resolver.resolve(provider).getAuthorizationUrl(state);
  }

  async completeConnection(
    provider: CloudProvider,
    code: string | undefined,
    state: string | undefined,
    callbackContext?: ProviderOAuthCallbackContext,
  ): Promise<{ userId: string; account: CloudAccountPublic }> {
    if (!code || !state) throw new BadRequestException('OAuth callback is missing code or state');
    const userId = this.stateService.consume(state, provider);
    if (!userId) throw new BadRequestException('OAuth state is invalid or expired');

    const adapter = this.resolver.resolve(provider);
    const result = await adapter.exchangeAuthorizationCode(code, callbackContext);
    const existing = await this.repository.findOne({
      where: { userId, provider, providerAccountId: result.account.providerAccountId },
    });
    const refreshTokenEncrypted = result.tokens.refreshToken
      ? this.encryption.encrypt(result.tokens.refreshToken)
      : existing?.refreshTokenEncrypted ?? null;
    if (!refreshTokenEncrypted && (result.tokens.expiresAt || !adapter.accessTokenMayNotExpire)) {
      throw new BadRequestException('Provider did not return a refresh token');
    }

    const account = existing ?? this.repository.create({
      userId,
      provider,
      providerAccountId: result.account.providerAccountId,
    });
    account.email = result.account.email ?? null;
    account.displayName = result.account.displayName ?? null;
    account.credentialType = CloudCredentialType.OAUTH2;
    account.credentialsEncrypted = null;
    account.configurationEncrypted = null;
    account.accessTokenEncrypted = this.encryption.encrypt(result.tokens.accessToken);
    account.refreshTokenEncrypted = refreshTokenEncrypted;
    account.tokenExpiresAt = result.tokens.expiresAt ?? null;
    account.scopes = result.tokens.scopes;
    account.status = CloudAccountStatus.CONNECTED;
    account.storageUsed = result.account.quota?.used == null ? null : String(result.account.quota.used);
    account.storageTotal = result.account.quota?.total == null ? null : String(result.account.quota.total);
    account.lastSyncAt = new Date();
    const saved = await this.repository.save(account);
    this.logger.log(JSON.stringify({ event: 'cloud_account.connected', userId, provider, accountId: saved.id }));
    return { userId, account: this.toPublic(saved) };
  }

  async refresh(userId: string, accountId: string): Promise<CloudAccountPublic> {
    const context = await this.getAuthorizedAccount(userId, accountId, true);
    const quota = await context.adapter.getStorageQuota(context.accessToken, accountId);
    await this.updateQuota(context.account, quota);
    return this.toPublic(context.account);
  }

  async getDisconnectImpact(userId: string, accountId: string): Promise<CloudAccountImpact> {
    if (!this.impact) return { accountId, replicas: 0, objectsOnlyOnThisAccount: 0, versionsAtRisk: 0, snapshotEntriesAtRisk: 0, activeBackupPolicies: 0, verifiedBackupsStored: 0, requiresConfirmation: false };
    return this.impact.inspect(userId, accountId);
  }

  async disconnect(userId: string, accountId: string, confirmImpact = false): Promise<{ disconnected: true }> {
    const account = await this.getOwnedAccount(userId, accountId);
    const impact = await this.getDisconnectImpact(userId, accountId);
    if (impact.requiresConfirmation && !confirmImpact) {
      throw new ConflictException({ code: 'ACCOUNT_IMPACT_CONFIRMATION_REQUIRED', impact });
    }
    let revocationAdapter: CloudProviderAdapter | undefined;
    let revocationTokenEncrypted = account.refreshTokenEncrypted;
    if (!revocationTokenEncrypted && account.credentialType === CloudCredentialType.OAUTH2 && !account.tokenExpiresAt) {
      revocationAdapter = this.resolver.resolve(account.provider);
      if (revocationAdapter.accessTokenMayNotExpire) revocationTokenEncrypted = account.accessTokenEncrypted;
    }
    if (revocationTokenEncrypted) {
      try {
        await (revocationAdapter ?? this.resolver.resolve(account.provider)).revokeAuthorization(
          this.encryption.decrypt(revocationTokenEncrypted),
        );
      } catch {
        this.logger.warn(JSON.stringify({ event: 'cloud_account.revoke_failed', accountId }));
      }
    }
    account.status = CloudAccountStatus.DISCONNECTED;
    account.accessTokenEncrypted = '';
    account.refreshTokenEncrypted = null;
    account.credentialsEncrypted = null;
    account.configurationEncrypted = null;
    account.tokenExpiresAt = new Date(0);
    await this.repository.save(account);
    return { disconnected: true };
  }

  async getAuthorizedAccount(userId: string, accountId: string, forceRefresh = false): Promise<AuthorizedCloudAccount> {
    const account = await this.getOwnedAccount(userId, accountId);
    if (account.status !== CloudAccountStatus.CONNECTED) {
      throw new ProviderException(ProviderErrorCode.ACCOUNT_NOT_CONNECTED, 409);
    }
    if (account.credentialType === CloudCredentialType.ACCESS_KEY) {
      if (!this.s3ProviderFactory) throw new ProviderException(ProviderErrorCode.PROVIDER_UNAVAILABLE, 503);
      const adapter = await this.s3ProviderFactory.create(account);
      return { account, adapter, accessToken: '' };
    }
    if (account.credentialType !== CloudCredentialType.OAUTH2) {
      throw new ProviderException(ProviderErrorCode.PROVIDER_CAPABILITY_NOT_SUPPORTED, 501);
    }
    const adapter = this.resolver.resolve(account.provider);
    let accessToken: string;
    try {
      accessToken = this.encryption.decrypt(account.accessTokenEncrypted);
    } catch {
      throw new ProviderException(ProviderErrorCode.PROVIDER_AUTH_EXPIRED, 401);
    }
    const shouldRefresh = forceRefresh || !account.tokenExpiresAt || account.tokenExpiresAt.getTime() - Date.now() < 60_000;
    if (!shouldRefresh) return { account, adapter, accessToken };
    if (!account.refreshTokenEncrypted) {
      if (!account.tokenExpiresAt && adapter.accessTokenMayNotExpire) return { account, adapter, accessToken };
      return this.markReauth(account);
    }
    try {
      const refreshToken = this.encryption.decrypt(account.refreshTokenEncrypted);
      const tokens = await adapter.refreshAccessToken(refreshToken);
      await this.persistRefreshedTokens(account, tokens, refreshToken);
      return { account, adapter, accessToken: tokens.accessToken };
    } catch (error) {
      await this.markAccountReauth(account);
      throw providerHttpError(error, ProviderErrorCode.PROVIDER_AUTH_EXPIRED);
    }
  }

  async updateQuota(account: CloudAccount, quota: { used: number; total: number | null }): Promise<void> {
    await this.repository.update(account.id, {
      storageUsed: String(quota.used),
      storageTotal: quota.total == null ? null : String(quota.total),
      lastSyncAt: new Date(),
    });
  }

  toPublic(account: CloudAccount): CloudAccountPublic {
    return {
      id: account.id,
      provider: account.provider,
      credentialType: account.credentialType ?? CloudCredentialType.OAUTH2,
      email: account.email,
      displayName: account.displayName,
      status: account.status,
      storage: {
        used: Number(account.storageUsed ?? 0),
        total: account.storageTotal == null ? null : Number(account.storageTotal),
      },
      scopes: account.scopes ?? [],
      lastSyncAt: account.lastSyncAt,
      lastHealthCheckAt: account.lastHealthCheckAt ?? null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  private async persistRefreshedTokens(account: CloudAccount, tokens: ProviderTokenSet, refreshToken: string): Promise<void> {
    account.accessTokenEncrypted = this.encryption.encrypt(tokens.accessToken);
    account.refreshTokenEncrypted = this.encryption.encrypt(tokens.refreshToken ?? refreshToken);
    account.tokenExpiresAt = tokens.expiresAt ?? null;
    account.scopes = tokens.scopes;
    account.status = CloudAccountStatus.CONNECTED;
    await this.repository.save(account);
  }

  private async markAccountReauth(account: CloudAccount): Promise<void> {
    account.status = CloudAccountStatus.REAUTH_REQUIRED;
    await this.repository.save(account);
  }

  private async markReauth(account: CloudAccount): Promise<never> {
    await this.markAccountReauth(account);
    throw new ProviderException(ProviderErrorCode.PROVIDER_AUTH_EXPIRED, 401);
  }
}
