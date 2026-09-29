import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { AddS3TargetDto, ConnectS3AccountDto, TestS3ConnectionDto, TestStoredS3TargetDto } from './dto/s3-target-input.dto';
import { S3CloudAccountService } from './s3-cloud-account.service';

@ApiTags('S3 Cloud Accounts')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('cloud-accounts/s3')
export class S3CloudAccountsController {
  constructor(private readonly service: S3CloudAccountService) {}

  @Post('test-connection')
  @ApiOperation({ summary: 'Test read access and optionally write access to an S3-compatible bucket' })
  testConnection(@Body() input: TestS3ConnectionDto) {
    return this.service.testConnection(input);
  }

  @Post('connect')
  @ApiOperation({ summary: 'Connect AWS S3 or an S3-compatible object-storage account; credentials are encrypted before storage' })
  connect(@Req() request: AuthenticatedRequest, @Body() input: ConnectS3AccountDto) {
    return this.service.connect(request.user.sub, input);
  }

  @Get(':accountId/targets')
  @ApiOperation({ summary: 'List safe metadata for the authenticated user storage targets' })
  listTargets(@Req() request: AuthenticatedRequest, @Param('accountId') accountId: string) {
    return this.service.listTargets(request.user.sub, accountId);
  }

  @Post(':accountId/targets')
  @ApiOperation({ summary: 'Add another bucket or managed prefix to an existing S3 account' })
  addTarget(@Req() request: AuthenticatedRequest, @Param('accountId') accountId: string, @Body() input: AddS3TargetDto) {
    return this.service.addTarget(request.user.sub, accountId, input);
  }

  @Post(':accountId/targets/:targetId/test-connection')
  @ApiOperation({ summary: 'Health check a stored target without exposing its credentials' })
  testTarget(@Req() request: AuthenticatedRequest, @Param('accountId') accountId: string, @Param('targetId') targetId: string, @Body() input: TestStoredS3TargetDto) {
    return this.service.testTarget(request.user.sub, accountId, targetId, input.verifyWrite === true);
  }
}
