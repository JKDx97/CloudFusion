import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { CloudAccountInfo } from '../common/cloud-file.interface';
import { ProviderTokenSet } from '../common/cloud-provider.interface';

@Injectable()
export class GoogleDriveOAuthService {
  private readonly scopes = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/drive',
  ];

  constructor(private readonly config: ConfigService) {}

  getAuthorizationUrl(state: string): string {
    const client = this.createClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      include_granted_scopes: true,
      prompt: 'consent',
      scope: this.scopes,
      state,
    });
  }

  async exchangeAuthorizationCode(code: string): Promise<{
    account: CloudAccountInfo;
    tokens: ProviderTokenSet;
  }> {
    const client = this.createClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token) throw new BadRequestException('Google OAuth did not return an access token');
    client.setCredentials(tokens);
    const user = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    const quota = await google.drive({ version: 'v3', auth: client }).about.get({ fields: 'storageQuota' });
    return {
      account: {
        providerAccountId: user.data.id ?? user.data.email ?? 'google-user',
        email: user.data.email ?? undefined,
        displayName: user.data.name ?? user.data.email ?? undefined,
        quota: {
          used: Number(quota.data.storageQuota?.usage ?? 0),
          total: quota.data.storageQuota?.limit ? Number(quota.data.storageQuota.limit) : null,
        },
      },
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? undefined,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
        scopes: tokens.scope?.split(' ') ?? this.scopes,
      },
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<ProviderTokenSet> {
    const client = this.createClient();
    client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await client.refreshAccessToken();
    if (!credentials.access_token) throw new BadRequestException('Google token refresh failed');
    return {
      accessToken: credentials.access_token,
      refreshToken,
      expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : undefined,
      scopes: credentials.scope?.split(' ') ?? this.scopes,
    };
  }

  async revokeAuthorization(refreshToken: string): Promise<void> {
    const client = this.createClient();
    await client.revokeToken(refreshToken);
  }

  createClient(accessToken?: string) {
    const client = this.buildClient();
    if (accessToken) client.setCredentials({ access_token: accessToken });
    return client;
  }

  private buildClient() {
    const clientId = this.config.get<string>('cloud.google.clientId');
    const clientSecret = this.config.get<string>('cloud.google.clientSecret');
    const redirectUri = this.config.get<string>('cloud.google.redirectUri');
    if (!clientId || !clientSecret || !redirectUri) {
      throw new BadRequestException('Google Drive is not configured');
    }
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }
}
