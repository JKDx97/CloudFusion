import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { AcceptWorkspaceInvitationDto } from './dto/accept-workspace-invitation.dto';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { CreateWorkspaceInvitationDto } from './dto/create-workspace-invitation.dto';
import { UpdateWorkspaceMemberDto } from './dto/update-workspace-member.dto';
import { WorkspaceListQueryDto } from './dto/workspace-list-query.dto';
import { WorkspaceMembershipService } from './workspace-membership.service';
import { WorkspacesService } from './workspaces.service';

@ApiTags('Workspaces')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly membership: WorkspaceMembershipService,
  ) {}

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

  @Get(':id/members')
  @ApiOperation({ summary: 'List workspace members only for an authenticated workspace member' })
  listMembers(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query() query: WorkspaceListQueryDto) {
    return this.membership.listMembers(request.user.sub, id, query.page, query.limit);
  }

  @Patch(':id/members/:userId')
  @ApiOperation({ summary: 'Change a workspace member role with owner/admin safeguards' })
  updateMemberRole(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Param('userId') userId: string, @Body() dto: UpdateWorkspaceMemberDto) {
    return this.membership.updateMemberRole(request.user.sub, id, userId, dto);
  }

  @Delete(':id/members/me')
  @ApiOperation({ summary: 'Leave a workspace; owners must transfer ownership first' })
  leave(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.membership.leave(request.user.sub, id);
  }

  @Delete(':id/members/:userId')
  @ApiOperation({ summary: 'Remove a workspace member without deleting their files' })
  removeMember(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Param('userId') userId: string) {
    return this.membership.removeMember(request.user.sub, id, userId);
  }

  @Post(':id/invitations')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create an expiring workspace invitation; its random token is returned once' })
  createInvitation(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() dto: CreateWorkspaceInvitationDto) {
    return this.membership.createInvitation(request.user.sub, id, dto);
  }

  @Get(':id/invitations')
  @ApiOperation({ summary: 'List workspace invitations without exposing token hashes' })
  listInvitations(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query() query: WorkspaceListQueryDto) {
    return this.membership.listInvitations(request.user.sub, id, query.page, query.limit);
  }

  @Delete(':id/invitations/:invitationId')
  @ApiOperation({ summary: 'Revoke a pending workspace invitation' })
  revokeInvitation(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Param('invitationId') invitationId: string) {
    return this.membership.revokeInvitation(request.user.sub, id, invitationId);
  }

  @Post('invitations/accept')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Accept an invitation only from the active account matching the invited email' })
  acceptInvitation(@Req() request: AuthenticatedRequest, @Body() dto: AcceptWorkspaceInvitationDto) {
    return this.membership.acceptInvitation(request.user.sub, dto);
  }
}
