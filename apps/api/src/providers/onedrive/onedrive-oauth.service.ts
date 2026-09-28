import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudAccountInfo } from '../common/cloud-file.interface';
import { ProviderTokenSet } from '../common/cloud-provider.interface';

@Injectable()
export class OneDriveOAuthService {
  private readonly scopes = ['offline_access', 'User.Read', 'Files.ReadWrite'];

  constructor(private readonly config: ConfigService) {}

  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.required('cloud.microsoft.clientId'),
      response_type: 'code',
      redirect_uri: this.required('cloud.microsoft.redirectUri'),
      response_mode: 'query',
      scope: this.scopes.join(' '),
      state,
    });
    return `https://login.microsoftonline.com/${encodeURIComponent(this.config.get<string>('cloud.microsoft.tenantId') ?? 'common')}/oauth2/v2.0/authorize?${params}`;
  }

  async exchangeAuthorizationCode(code: string): Promise<{ account: CloudAccountInfo; tokens: ProviderTokenSet }> {
    const token = await this.tokenRequest({ grant_type: 'authorization_code', code });
    const user = await this.graph('/me', token.access_token);
    const drive = await this.graph('/me/drive', token.access_token);
    return {
      account: {
        providerAccountId: String(user.id),
        email: user.mail ?? user.userPrincipalName,
        displayName: user.displayName ?? user.userPrincipalName,
        quota: {
          used: Number(drive.quota?.used ?? 0),
          total: drive.quota?.total == null ? null : Number(drive.quota.total),
        },
      },
      tokens: this.toTokens(token),
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<ProviderTokenSet> {
    const token = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return this.toTokens(token, refreshToken);
  }

  async revokeAuthorization(_refreshToken: string): Promise<void> {
    // Microsoft Graph has no general delegated-token revocation endpoint.
  }

  private async tokenRequest(values: Record<string, string>): Promise<Record<string, unknown> & { access_token: string }> {
    const body = new URLSearchParams({
      client_id: this.required('cloud.microsoft.clientId'),
      client_secret: this.required('cloud.microsoft.clientSecret'),
      scope: this.scopes.join(' '),
      ...values,
    });
    const response = await fetch(this.tokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok || typeof payload.access_token !== 'string') {
      throw new BadRequestException('Microsoft OAuth token exchange failed');
    }
    return payload as Record<string, unknown> & { access_token: string };
  }

  private async graph(path: string, accessToken: string): Promise<any> {
    const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new BadRequestException('Microsoft Graph account lookup failed');
    return response.json();
  }

  private toTokens(token: Record<string, unknown> & { access_token: string }, previousRefreshToken?: string): ProviderTokenSet {
    return {
      accessToken: token.access_token,
      refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : previousRefreshToken,
      expiresAt: new Date(Date.now() + Number(token.expires_in ?? 3600) * 1000),
      scopes: typeof token.scope === 'string' ? token.scope.split(' ') : this.scopes,
    };
  }

  private tokenUrl(): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.config.get<string>('cloud.microsoft.tenantId') ?? 'common')}/oauth2/v2.0/token`;
  }

  private required(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) throw new BadRequestException('OneDrive is not configured');
    return value;
  }
}
