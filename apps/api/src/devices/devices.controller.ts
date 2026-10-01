import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { ConfigureDeviceStorageDto } from './dto/configure-device-storage.dto';
import { ReportDeviceStorageDto } from './dto/report-device-storage.dto';
import { UpdateDeviceSettingsDto } from './dto/update-device-settings.dto';
import { DevicesService } from './devices.service';

@ApiTags('devices')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @ApiOperation({
    summary: 'List devices registered to the authenticated user',
  })
  list(@Req() request: AuthenticatedRequest) {
    return this.devices.list(request.user.sub);
  }

  @Get('mesh-peers')
  @ApiOperation({
    summary: 'List the authenticated user’s enabled LAN and Internet mesh peers',
  })
  listMeshPeers(@Req() request: AuthenticatedRequest) {
    return this.devices.listMeshPeers(request.user.sub);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a device registered to the authenticated user',
  })
  get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.devices.getPublic(request.user.sub, id);
  }

  @Patch(':id/settings')
  @ApiOperation({
    summary: 'Update network and storage-contribution settings for an owned device',
  })
  updateSettings(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpdateDeviceSettingsDto) {
    return this.devices.updateSettings(request.user.sub, id, dto);
  }

  @Get(':id/storage')
  @ApiOperation({
    summary: 'Get the storage capacity and presence configuration for an owned device',
  })
  getStorageConfiguration(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.devices.getStorageConfiguration(request.user.sub, id);
  }

  @Patch(':id/storage')
  @ApiOperation({
    summary: 'Opt an owned device in or out of storage contribution and configure its capacity',
  })
  configureStorage(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() dto: ConfigureDeviceStorageDto) {
    return this.devices.configureStorage(request.user.sub, id, dto);
  }

  @Post(':id/storage/heartbeat')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Report used bytes from the authenticated contributing device and refresh presence',
  })
  reportStorageHeartbeat(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() dto: ReportDeviceStorageDto) {
    return this.devices.reportStorageHeartbeat(request.user.sub, id, request.user.deviceId, dto);
  }

  @Post(':id/heartbeat')
  @ApiOperation({
    summary: 'Refresh the presence timestamp of an active device session',
  })
  heartbeat(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.devices.touch(request.user.sub, id);
  }

  @Post(':id/revoke')
  @ApiOperation({
    summary: 'Revoke a device and invalidate its device-bound tokens',
  })
  revoke(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.devices.revoke(request.user.sub, id);
  }
}
