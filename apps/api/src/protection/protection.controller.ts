import { Controller, Get, MessageEvent, Param, Patch, Req, Sse, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { DataProtectionEventsService } from '../realtime/data-protection-events.service';
import { ProtectionService } from './protection.service';

@ApiTags('Data Protection')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('protection')
export class ProtectionController {
  constructor(private readonly protection: ProtectionService, private readonly events: DataProtectionEventsService) {}

  @Sse('events')
  @ApiOperation({ summary: 'Stream authenticated, user-scoped data-protection events' })
  eventsForUser(@Req() request: AuthenticatedRequest): Observable<MessageEvent> {
    return this.events.events(request.user.sub);
  }

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
