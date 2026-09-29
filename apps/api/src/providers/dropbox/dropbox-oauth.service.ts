import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Dropbox, DropboxAuth } from 'dropbox';
import { CloudAccountInfo } from '../common/cloud-file.interface';
import { ProviderTokenSet } from '../common/cloud-provider.interface';

export const DROPBOX_SCOPES = [
  'account_info.read',
  'files.metadata.read',
  'files.content.read',
  'files.content.write',
];

@Injectable()
export class DropboxOAuthService {
  constructor(private readonly config: ConfigService) {}

  getAuthorizationUrl(state: string): string {
    this.assertEnabled();
    const params = new URLSearchParams({
      client_id: this.required('cloud.dropbox.clientId'),
      response_type: 'code',
      redirect_uri: this.required('cloud.dropbox.redirectUri'),
      token_access_type: 'offline',
      scope: DROPBOX_SCOPES.join(' '),
      state,
    });
    return `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
  }

  async exchangeAuthorizationCode(code: string): Promise<{ account: CloudAccountInfo; tokens: ProviderTokenSet }> {
    this.assertEnabled();
    const auth = this.createAuth();
    try {
      const response = await auth.getAccessTokenFromCode(this.required('cloud.dropbox.redirectUri'), code);
      const token = response.result as {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
        scope?: unknown;
      };
      if (typeof token.access_token !== 'string') throw new Error('Dropbox access token missing');
      if (typeof token.refresh_token !== 'string') throw new Error('Dropbox offline refresh token missing');

      const user = (await new Dropbox({ accessToken: token.access_token }).usersGetCurrentAccount()).result;
      const space = (await new Dropbox({ accessToken: token.access_token }).usersGetSpaceUsage()).result;
      const total = space.allocation['.tag'] === 'individual' ? space.allocation.allocated : null;
      return {
        account: {
          providerAccountId: user.account_id,
          email: user.email,
          displayName: user.name.display_name || user.email,
          quota: { used: space.used, total },
        },
        tokens: {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: new Date(Date.now() + Number(token.expires_in ?? 14400) * 1000),
          scopes: typeof token.scope === 'string' ? token.scope.split(' ') : DROPBOX_SCOPES,
        },
      };
    } catch {
      throw new BadRequestException('Dropbox OAuth authorization failed');
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<ProviderTokenSet> {
    const auth = this.createAuth(refreshToken);
    try {
      await auth.refreshAccessToken();
      const accessToken = auth.getAccessToken();
      if (!accessToken) throw new Error('Dropbox token refresh returned no access token');
      return {
        accessToken,
        refreshToken,
        expiresAt: auth.getAccessTokenExpiresAt() || undefined,
        scopes: DROPBOX_SCOPES,
      };
    } catch {
      throw new BadRequestException('Dropbox token refresh failed');
    }
  }

  async revokeAuthorization(refreshToken: string): Promise<void> {
    const auth = this.createAuth(refreshToken);
    await auth.refreshAccessToken();
    await new Dropbox({ auth }).authTokenRevoke();
  }

  private createAuth(refreshToken?: string): DropboxAuth {
    return new DropboxAuth({
      clientId: this.required('cloud.dropbox.clientId'),
      clientSecret: this.required('cloud.dropbox.clientSecret'),
      ...(refreshToken ? { refreshToken } : {}),
    });
  }

  private required(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) throw new BadRequestException('Dropbox is not configured');
    return value;
  }

  private assertEnabled(): void {
    if (this.config.get<boolean>('cloud.dropbox.enabled') === false) {
      throw new ServiceUnavailableException('Dropbox integration is disabled');
    }
  }
}
