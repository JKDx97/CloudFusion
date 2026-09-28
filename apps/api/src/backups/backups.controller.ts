import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CreateBackupPolicyDto } from './dto/create-backup-policy.dto';
import { UpdateBackupPolicyDto } from './dto/update-backup-policy.dto';
import { BackupService } from './backup.service';

@ApiTags('Backups')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller()
export class BackupsController {
  constructor(private readonly backups: BackupService) {}

  @Get('backup-policies')
  @ApiOperation({ summary: 'List the authenticated user’s scheduled backup policies' })
  listPolicies(@Req() request: AuthenticatedRequest) { return this.backups.listPolicies(request.user.sub); }

  @Post('backup-policies')
  @ApiOperation({ summary: 'Create a scheduled encrypted snapshot backup policy' })
  createPolicy(@Req() request: AuthenticatedRequest, @Body() dto: CreateBackupPolicyDto) { return this.backups.createPolicy(request.user.sub, dto); }

  @Patch('backup-policies/:id')
  @ApiOperation({ summary: 'Update an owned backup policy' })
  updatePolicy(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpdateBackupPolicyDto) { return this.backups.updatePolicy(request.user.sub, id, dto); }

  @Delete('backup-policies/:id')
  @ApiOperation({ summary: 'Delete an owned backup policy without deleting backup history' })
  deletePolicy(@Req() request: AuthenticatedRequest, @Param('id') id: string) { return this.backups.deletePolicy(request.user.sub, id); }

  @Post('backup-policies/:id/run')
  @ApiOperation({ summary: 'Queue an immediate backup for an owned policy' })
  runPolicy(@Req() request: AuthenticatedRequest, @Param('id') id: string) { return this.backups.runPolicy(request.user.sub, id); }

  @Get('backups')
  @ApiOperation({ summary: 'List owned backup runs' })
  listJobs(@Req() request: AuthenticatedRequest) { return this.backups.listJobs(request.user.sub); }

  @Get('backups/:id')
  @ApiOperation({ summary: 'Get progress and verification information for an owned backup' })
  getJob(@Req() request: AuthenticatedRequest, @Param('id') id: string) { return this.backups.getJob(request.user.sub, id); }

  @Post('backups/:id/restore')
  @ApiOperation({ summary: 'Restore a verified backup snapshot, reattaching encrypted backup copies if required' })
  restore(@Req() request: AuthenticatedRequest, @Param('id') id: string) { return this.backups.restore(request.user.sub, id); }
}
