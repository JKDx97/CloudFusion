import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { WorkspaceListQueryDto } from './dto/workspace-list-query.dto';
import { WorkspacesService } from './workspaces.service';

@ApiTags('Workspaces')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a workspace with its creator as the initial owner' })
  create(@Req() request: AuthenticatedRequest, @Body() dto: CreateWorkspaceDto) {
    return this.workspaces.create(request.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List only workspaces where the authenticated user is a member' })
  list(@Req() request: AuthenticatedRequest, @Query() query: WorkspaceListQueryDto) {
    return this.workspaces.list(request.user.sub, query.page, query.limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get workspace details only when the authenticated user is a member' })
  get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.workspaces.get(request.user.sub, id);
  }
}
