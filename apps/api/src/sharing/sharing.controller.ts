import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CreateShareDto } from './dto/create-share.dto';
import { ShareListQueryDto } from './dto/share-list-query.dto';
import { SearchUsersQueryDto } from './dto/search-users-query.dto';
import { UpdateShareDto } from './dto/update-share.dto';
import { SharingService } from './sharing.service';

@ApiTags('Sharing')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('shares')
export class SharingController {
  constructor(private readonly sharing: SharingService) {}

  @Post()
  @ApiOperation({ summary: 'Share a personal file or folder with an active CloudFusion user' })
  create(@Req() request: AuthenticatedRequest, @Body() dto: CreateShareDto) {
    return this.sharing.create(request.user.sub, dto);
  }

  @Get('received')
  @ApiOperation({ summary: 'List active resources shared directly with the authenticated user' })
  received(@Req() request: AuthenticatedRequest, @Query() query: ShareListQueryDto) {
    return this.sharing.received(request.user.sub, query);
  }

  @Get('created')
  @ApiOperation({ summary: 'List active shares created by the authenticated user' })
  created(@Req() request: AuthenticatedRequest, @Query() query: ShareListQueryDto) {
    return this.sharing.created(request.user.sub, query);
  }

  @Get('users')
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @ApiQuery({ name: 'q', required: true, description: 'Exact email or a username prefix of at least two characters' })
  @ApiOperation({ summary: 'Search a limited set of active users without exposing the full user directory' })
  searchUsers(@Req() request: AuthenticatedRequest, @Query() query: SearchUsersQueryDto) {
    return this.sharing.searchUsers(request.user.sub, query);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change the role of a share owned by the authenticated user' })
  update(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpdateShareDto) {
    return this.sharing.update(request.user.sub, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Immediately revoke a share owned by the authenticated user' })
  revoke(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.sharing.revoke(request.user.sub, id);
  }
}
