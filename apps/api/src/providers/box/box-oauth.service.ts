import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BoxClient, BoxDeveloperTokenAuth, BoxOAuth, OAuthConfig } from 'box-node-sdk';
import { CloudAccountInfo } from '../common/cloud-file.interface';
import { ProviderTokenSet } from '../common/cloud-provider.interface';

export const BOX_OAUTH_SCOPES = ['root_readwrite'];

@Injectable()
export class BoxOAuthService {
  constructor(private readonly config: ConfigService) {}

  getAuthorizationUrl(state: string): string {
    this.assertEnabled();
    return this.createOAuth().getAuthorizeUrl({
      responseType: 'code',
      redirectUri: this.required('cloud.box.redirectUri'),
      scope: BOX_OAUTH_SCOPES.join(' '),
      state,
    });
  }

  async exchangeAuthorizationCode(code: string): Promise<{ account: CloudAccountInfo; tokens: ProviderTokenSet }> {
    this.assertEnabled();
    try {
      const oauth = this.createOAuth();
      const token = await oauth.getTokensAuthorizationCodeGrant(code);
      if (!token.accessToken || !token.refreshToken) throw new Error('Box OAuth token response is incomplete');
      const user = await new BoxClient({ auth: oauth }).users.getUserMe({
        fields: ['id', 'name', 'login', 'space_used', 'space_amount'],
      });
      return {
        account: {
          providerAccountId: user.id,
          ...(user.login ? { email: user.login } : {}),
          ...(user.name ? { displayName: user.name } : {}),
          quota: {
            used: typeof user.spaceUsed === 'number' ? user.spaceUsed : 0,
            total: typeof user.spaceAmount === 'number' ? user.spaceAmount : null,
          },
        },
        tokens: this.toTokenSet(token),
      };
    } catch {
      throw new BadRequestException('Box OAuth authorization failed');
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<ProviderTokenSet> {
    try {
      const oauth = this.createOAuth();
      await oauth.tokenStorage.store({ refreshToken });
      return this.toTokenSet(await oauth.refreshToken(), refreshToken);
    } catch {
      throw new BadRequestException('Box OAuth token refresh failed');
    }
  }

  async revokeAuthorization(refreshToken: string): Promise<void> {
    try {
      const oauth = this.createOAuth();
      await oauth.tokenStorage.store({ refreshToken });
      await oauth.refreshToken();
      await oauth.revokeToken();
    } catch {
      throw new BadRequestException('Box OAuth token revocation failed');
    }
  }

  createClient(accessToken: string): BoxClient {
    return new BoxClient({ auth: new BoxDeveloperTokenAuth({ token: accessToken }) });
  }

  private createOAuth(): BoxOAuth {
    return new BoxOAuth({
      config: new OAuthConfig({
        clientId: this.required('cloud.box.clientId'),
        clientSecret: this.required('cloud.box.clientSecret'),
      }),
    });
  }

  private toTokenSet(token: { accessToken?: string; refreshToken?: string; expiresIn?: number }, fallbackRefreshToken?: string): ProviderTokenSet {
    if (!token.accessToken) throw new BadRequestException('Box OAuth response did not include an access token');
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? fallbackRefreshToken,
      expiresAt: typeof token.expiresIn === 'number' ? new Date(Date.now() + token.expiresIn * 1000) : undefined,
      scopes: BOX_OAUTH_SCOPES,
    };
  }

  private assertEnabled(): void {
    if (this.config.get<boolean>('cloud.box.enabled') === false) {
      throw new ServiceUnavailableException('Box integration is disabled');
    }
  }

  private required(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) throw new BadRequestException('Box is not configured');
    return value;
  }
}
