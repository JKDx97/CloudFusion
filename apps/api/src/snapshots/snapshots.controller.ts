import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CreateSnapshotDto } from './dto/create-snapshot.dto';
import { RestoreSnapshotEntryDto } from './dto/restore-snapshot-entry.dto';
import { SnapshotsService } from './snapshots.service';

@ApiTags('Snapshots')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('snapshots')
export class SnapshotsController {
  constructor(private readonly snapshots: SnapshotsService) {}

  @Post()
  @ApiOperation({ summary: 'Create an immutable logical snapshot of the authenticated user’s drive state' })
  create(@Req() request: AuthenticatedRequest, @Body() dto: CreateSnapshotDto) {
    return this.snapshots.create(request.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List snapshots belonging to the authenticated user' })
  list(@Req() request: AuthenticatedRequest) {
    return this.snapshots.list(request.user.sub);
  }

  @Get(':id/entries')
  @ApiOperation({ summary: 'Browse entries in an owned snapshot' })
  entries(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.snapshots.getEntries(request.user.sub, id);
  }

  @Post(':id/entries/:entryId/restore')
  @ApiOperation({ summary: 'Restore one snapshot entry using overwrite, rename, or skip conflict handling' })
  restoreEntry(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Body() dto: RestoreSnapshotEntryDto,
  ) {
    return this.snapshots.restoreEntry(request.user.sub, id, entryId, dto.strategy, dto.targetParentId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an owned snapshot unless it is marked immutable' })
  delete(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.snapshots.delete(request.user.sub, id);
  }
}
