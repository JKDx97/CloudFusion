import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { UpdateDeviceSettingsDto } from './dto/update-device-settings.dto';
import { DevicesService } from './devices.service';

@ApiTags('devices')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @ApiOperation({ summary: 'List devices registered to the authenticated user' })
  list(@Req() request: AuthenticatedRequest) {
    return this.devices.list(request.user.sub);
  }

  @Get('mesh-peers')
  @ApiOperation({ summary: 'List the authenticated user’s enabled LAN mesh peers' })
  listMeshPeers(@Req() request: AuthenticatedRequest) {
    return this.devices.listMeshPeers(request.user.sub);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a device registered to the authenticated user' })
  get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.devices.getPublic(request.user.sub, id);
  }

  @Patch(':id/settings')
  @ApiOperation({ summary: 'Update network and storage-contribution settings for an owned device' })
  updateSettings(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpdateDeviceSettingsDto) {
    return this.devices.updateSettings(request.user.sub, id, dto);
  }

  @Post(':id/heartbeat')
  @ApiOperation({ summary: 'Refresh the presence timestamp of an active device session' })
  heartbeat(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.devices.touch(request.user.sub, id);
  }

  @Post(':id/revoke')
  @ApiOperation({ summary: 'Revoke a device and invalidate its device-bound tokens' })
  revoke(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.devices.revoke(request.user.sub, id);
  }
}
