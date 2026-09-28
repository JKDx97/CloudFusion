import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CloudSearchService } from './cloud-search.service';

@ApiTags('Cloud Search')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('cloud-search')
export class CloudSearchController {
  constructor(private readonly service: CloudSearchService) {}

  @Get()
  @ApiOperation({ summary: 'Search concurrently across connected cloud accounts' })
  @ApiQuery({ name: 'q', required: true, description: 'File or folder name fragment' })
  search(@Req() request: AuthenticatedRequest, @Query('q') query: string) {
    return this.service.search(request.user.sub, query ?? '');
  }
}
