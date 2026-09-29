import { Controller, Get, HttpCode, HttpStatus, Logger, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CloudProvider } from '../providers/common/cloud-provider.enum';
import { CloudAccountService } from './cloud-account.service';

@ApiTags('Cloud Accounts')
@Controller('cloud-accounts/pcloud')
export class PCloudOAuthController {
  private readonly logger = new Logger(PCloudOAuthController.name);

  constructor(private readonly accounts: CloudAccountService) {}

  @Post('connect')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start pCloud OAuth authorization' })
  connect(@Req() request: AuthenticatedRequest) {
    return { authorizationUrl: this.accounts.beginConnection(request.user.sub, CloudProvider.PCLOUD) };
  }

  @Get('callback')
  @ApiOperation({ summary: 'Handle pCloud OAuth callback' })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('hostname') hostname: string | undefined,
    @Query('locationid') locationId: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const frontend = process.env.FRONTEND_URL ?? 'http://localhost:4200';
    if (error) {
      response.redirect(`${frontend}/providers?cloudError=oauth_cancelled`);
      return;
    }
    try {
      const result = await this.accounts.completeConnection(CloudProvider.PCLOUD, code, state, { hostname, locationId });
      response.redirect(`${frontend}/providers?connected=${encodeURIComponent(result.account.id)}&provider=PCLOUD`);
    } catch (cause: unknown) {
      const responseBody = cause && typeof cause === 'object' && 'getResponse' in cause
        ? (cause as { getResponse: () => unknown }).getResponse()
        : undefined;
      const message = typeof responseBody === 'string'
        ? responseBody
        : responseBody && typeof responseBody === 'object' && 'message' in responseBody
          ? String((responseBody as { message: unknown }).message)
          : '';
      const cloudError = message.includes('not configured')
        ? 'provider_not_configured'
        : message.includes('OAuth state is invalid or expired')
          ? 'oauth_state_invalid'
          : 'connection_failed';
      this.logger.warn(JSON.stringify({ event: 'cloud_account.connection_failed', provider: CloudProvider.PCLOUD, cloudError }));
      response.redirect(`${frontend}/providers?cloudError=${cloudError}`);
    }
  }
}
