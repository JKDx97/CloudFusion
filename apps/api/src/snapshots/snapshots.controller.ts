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

  @Post(':id/restore')
  @ApiOperation({ summary: 'Queue a full snapshot restore as a background job' })
  restoreSnapshot(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.snapshots.queueSnapshotRestore(request.user.sub, id);
  }

  @Get('restore-jobs')
  @ApiOperation({ summary: 'List the authenticated user’s full snapshot restore jobs' })
  restoreJobs(@Req() request: AuthenticatedRequest) {
    return this.snapshots.listRestoreJobs(request.user.sub);
  }

  @Get('restore-jobs/:jobId')
  @ApiOperation({ summary: 'Get progress and errors for an owned snapshot restore job' })
  restoreJob(@Req() request: AuthenticatedRequest, @Param('jobId') jobId: string) {
    return this.snapshots.getRestoreJob(request.user.sub, jobId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an owned snapshot unless it is marked immutable' })
  delete(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.snapshots.delete(request.user.sub, id);
  }
}
