import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { AdvertiseAvailabilityDto } from './dto/advertise-availability.dto';
import { AdvertiseAvailabilityBatchDto } from './dto/advertise-availability-batch.dto';
import { AuthorizePeerTransferDto } from './dto/authorize-peer-transfer.dto';
import { ClaimPeerTransferDto } from './dto/claim-peer-transfer.dto';
import { ListAvailabilityDto } from './dto/list-availability.dto';
import { UpdatePeerTransferStateDto } from './dto/update-peer-transfer-state.dto';
import { CompleteDeviceStorageReplicaDto } from './dto/complete-device-storage-replica.dto';
import { DeviceStorageReplicaService } from './device-storage-replica.service';
import { P2pService } from './p2p.service';
import { UpdateP2pPrivacyDto } from './dto/update-p2p-privacy.dto';

@ApiTags('p2p')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('p2p')
export class P2pController {
  constructor(
    private readonly p2p: P2pService,
    private readonly deviceStorage: DeviceStorageReplicaService,
  ) {}

  @Get('privacy')
  @ApiOperation({ summary: 'Read the account-wide P2P privacy control' })
  getPrivacySettings(@Req() request: AuthenticatedRequest) {
    return this.p2p.getPrivacySettings(request.user.sub);
  }

  @Patch('privacy')
  @ApiOperation({ summary: 'Enable or disable all P2P discovery and transfers for the account' })
  updatePrivacySettings(@Req() request: AuthenticatedRequest, @Body() dto: UpdateP2pPrivacyDto) {
    return this.p2p.updatePrivacySettings(request.user.sub, dto.enabled);
  }

  @Post('storage/replicas/next')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Assign one whole-file device replica after checking cloud durability and free device capacity' })
  nextDeviceStorageReplica(@Req() request: AuthenticatedRequest) {
    return this.deviceStorage.next(request.user.sub, request.user.deviceId);
  }

  @Post('storage/replicas/:id/complete')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Confirm a device replica after the client verifies its exact size and SHA-256' })
  completeDeviceStorageReplica(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CompleteDeviceStorageReplicaDto,
  ) {
    return this.deviceStorage.complete(request.user.sub, request.user.deviceId, id, dto);
  }

  @Post('availability')
  @ApiOperation({ summary: 'Advertise a locally cached, authorized CloudFusion file version' })
  advertiseAvailability(@Req() request: AuthenticatedRequest, @Body() dto: AdvertiseAvailabilityDto) {
    return this.p2p.advertiseAvailability(request.user.sub, request.user.deviceId, dto);
  }

  @Post('availability/batch')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @ApiOperation({ summary: 'Advertise up to 500 verified local file versions in one bounded request' })
  advertiseAvailabilityBatch(
    @Req() request: AuthenticatedRequest,
    @Body() dto: AdvertiseAvailabilityBatchDto,
  ) {
    return this.p2p.advertiseAvailabilityBatch(request.user.sub, request.user.deviceId, dto.items);
  }

  @Delete('availability/:nodeId/:versionId')
  @ApiOperation({ summary: 'Withdraw this device’s local availability for a file version' })
  withdrawAvailability(
    @Req() request: AuthenticatedRequest,
    @Param('nodeId', new ParseUUIDPipe()) nodeId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
  ) {
    return this.p2p.withdrawAvailability(request.user.sub, request.user.deviceId, nodeId, versionId);
  }

  @Get('availability')
  @ApiOperation({ summary: 'List authorized devices advertising this exact file version' })
  listAvailability(@Req() request: AuthenticatedRequest, @Query() query: ListAvailabilityDto) {
    return this.p2p.listAvailability(request.user.sub, query.nodeId, query.versionId);
  }

  @Post('transfers/authorize')
  @ApiOperation({ summary: 'Create a short-lived, device-bound ticket for one exact readable file version' })
  authorizeTransfer(@Req() request: AuthenticatedRequest, @Body() dto: AuthorizePeerTransferDto) {
    return this.p2p.authorizeTransfer(request.user.sub, request.user.deviceId, dto);
  }

  @Post('transfers/:id/claim')
  @ApiOperation({ summary: 'Validate and consume a ticket on its named source device' })
  claimTransfer(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ClaimPeerTransferDto,
  ) {
    return this.p2p.claimTransfer(request.user.sub, request.user.deviceId, id, dto.ticket);
  }

  @Get('transfers/:id')
  @ApiOperation({ summary: 'Read an authorized peer transfer session as one of its participating devices' })
  getTransfer(@Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.p2p.getTransfer(request.user.sub, request.user.deviceId, id);
  }

  @Post('transfers/:id/state')
  @ApiOperation({ summary: 'Advance a peer transfer through validated state transitions' })
  updateState(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePeerTransferStateDto,
  ) {
    return this.p2p.updateTransferState(
      request.user.sub,
      request.user.deviceId,
      id,
      dto.status,
      dto.transport,
      dto.bytesTransferred,
    );
  }

  @Post('transfers/:id/cancel')
  @ApiOperation({ summary: 'Cancel a peer transfer as one of its participating devices' })
  cancelTransfer(@Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.p2p.cancelTransfer(request.user.sub, request.user.deviceId, id);
  }
}
