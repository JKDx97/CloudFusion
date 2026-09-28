import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CloudAccountService } from './cloud-account.service';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CloudProvider } from '../providers/common/cloud-provider.enum';

@ApiTags('Cloud Accounts')
@ApiBearerAuth()
@Controller('cloud-accounts')
export class CloudAccountsController {
  constructor(private readonly service: CloudAccountService) {}

  @Get()
  @UseGuards(AccessTokenGuard)
  @ApiOperation({ summary: 'List the authenticated user cloud accounts' })
  list(@Req() request: AuthenticatedRequest) {
    return this.service.list(request.user.sub);
  }

  @Get('storage-summary')
  @UseGuards(AccessTokenGuard)
  @ApiOperation({ summary: 'Return the aggregated storage of connected accounts' })
  summary(@Req() request: AuthenticatedRequest) {
    return this.service.getStorageSummary(request.user.sub);
  }

  @Get('google/connect')
  @UseGuards(AccessTokenGuard)
  @ApiOperation({ summary: 'Start Google Drive OAuth' })
  connectGoogle(@Req() request: AuthenticatedRequest, @Res() response: Response): void {
    response.redirect(this.service.beginConnection(request.user.sub, CloudProvider.GOOGLE_DRIVE));
  }

  @Get('google/callback')
  @ApiOperation({ summary: 'Handle Google Drive OAuth callback' })
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    await this.completeCallback(CloudProvider.GOOGLE_DRIVE, code, state, error, response);
  }

  @Get('onedrive/connect')
  @UseGuards(AccessTokenGuard)
  @ApiOperation({ summary: 'Start Microsoft OneDrive OAuth' })
  connectOneDrive(@Req() request: AuthenticatedRequest, @Res() response: Response): void {
    response.redirect(this.service.beginConnection(request.user.sub, CloudProvider.ONEDRIVE));
  }

  @Get('onedrive/callback')
  @ApiOperation({ summary: 'Handle Microsoft OneDrive OAuth callback' })
  async oneDriveCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    await this.completeCallback(CloudProvider.ONEDRIVE, code, state, error, response);
  }

  @Post(':id/refresh')
  @UseGuards(AccessTokenGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh a provider access token and quota' })
  @ApiParam({ name: 'id', description: 'CloudFusion account UUID' })
  refresh(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.service.refresh(request.user.sub, id);
  }

  @Get(':id/impact')
  @UseGuards(AccessTokenGuard)
  @ApiOperation({ summary: 'Show backups, versions and replicas affected by disconnecting a provider account' })
  @ApiParam({ name: 'id', description: 'CloudFusion account UUID' })
  disconnectImpact(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.service.getDisconnectImpact(request.user.sub, id);
  }

  @Delete(':id')
  @UseGuards(AccessTokenGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disconnect a provider account' })
  @ApiQuery({ name: 'confirmImpact', required: false, type: Boolean })
  disconnect(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('confirmImpact') confirmImpact?: string) {
    return this.service.disconnect(request.user.sub, id, confirmImpact === 'true');
  }

  private async completeCallback(
    provider: CloudProvider,
    code: string | undefined,
    state: string | undefined,
    error: string | undefined,
    response: Response,
  ): Promise<void> {
    const frontend = process.env.FRONTEND_URL ?? 'http://localhost:4200';
    if (error) {
      response.redirect(`${frontend}/dashboard?cloudError=oauth_cancelled`);
      return;
    }
    try {
      const result = await this.service.completeConnection(provider, code, state);
      response.redirect(`${frontend}/dashboard?connected=${result.account.id}`);
    } catch {
      response.redirect(`${frontend}/dashboard?cloudError=connection_failed`);
    }
  }
}
