import { Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { ProtectionService } from './protection.service';

@ApiTags('Data Protection')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('protection')
export class ProtectionController {
  constructor(private readonly protection: ProtectionService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get safe data-protection metrics without exposing key material' })
  overview(@Req() request: AuthenticatedRequest) { return this.protection.overview(request.user.sub); }

  @Get('alerts')
  @ApiOperation({ summary: 'List protection alerts for the authenticated user' })
  alerts(@Req() request: AuthenticatedRequest) { return this.protection.listAlerts(request.user.sub); }

  @Patch('alerts/:id/resolve')
  @ApiOperation({ summary: 'Resolve an owned protection alert' })
  resolve(@Req() request: AuthenticatedRequest, @Param('id') id: string) { return this.protection.resolveAlert(request.user.sub, id); }
}
