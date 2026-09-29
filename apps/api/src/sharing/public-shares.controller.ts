import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CreatePublicShareDto } from './dto/create-public-share.dto';
import { PublicShareDownloadDto } from './dto/public-share-download.dto';
import { PublicShareAccessDto } from './dto/public-share-access.dto';
import { PublicSharesService } from './public-shares.service';

@ApiTags('Public Sharing')
@Controller()
export class PublicSharesController {
  constructor(private readonly service: PublicSharesService) {}

  @Post('public-shares')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a secure public link for an owned file' })
  create(@Req() request: AuthenticatedRequest, @Body() dto: CreatePublicShareDto) {
    return this.service.create(request.user.sub, dto);
  }

  @Get('public-shares')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'nodeId', required: false })
  @ApiOperation({ summary: 'List public links created by the authenticated user without revealing tokens or password hashes' })
  list(@Req() request: AuthenticatedRequest, @Query('page') page?: string, @Query('limit') limit?: string, @Query('nodeId') nodeId?: string) {
    const currentPage = Math.max(1, Number(page) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(limit) || 25));
    return this.service.list(request.user.sub, currentPage, pageSize, nodeId);
  }

  @Delete('public-shares/:id')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Immediately revoke a public link owned by the authenticated user' })
  revoke(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.service.revoke(request.user.sub, id);
  }

  @Get('s/:token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Resolve a public link to safe display metadata; protected links reveal no file details' })
  publicInfo(@Param('token') token: string) {
    return this.service.publicInfo(token);
  }

  @Post('s/:token/access')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify a public link password without incrementing its download quota' })
  accessInfo(@Param('token') token: string, @Body() dto: PublicShareAccessDto) {
    return this.service.publicInfo(token, dto.password);
  }

  @Post('s/:token/download')
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @ApiOperation({ summary: 'Download through a validated public link, optional Argon2 password and atomic download quota' })
  async download(
    @Param('token') token: string,
    @Body() dto: PublicShareDownloadDto,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.service.download(token, dto);
    const safeName = encodeURIComponent(file.fileName).replace(/['()]/g, (character) => `%${character.charCodeAt(0).toString(16)}`);
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeName}`);
    if (file.mimeType) response.setHeader('Content-Type', file.mimeType);
    if (file.size != null) response.setHeader('Content-Length', String(file.size));
    file.stream.pipe(response);
  }
}
