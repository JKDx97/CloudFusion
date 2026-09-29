import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { AdvertiseAvailabilityDto } from './dto/advertise-availability.dto';
import { AuthorizePeerTransferDto } from './dto/authorize-peer-transfer.dto';
import { ClaimPeerTransferDto } from './dto/claim-peer-transfer.dto';
import { ListAvailabilityDto } from './dto/list-availability.dto';
import { UpdatePeerTransferStateDto } from './dto/update-peer-transfer-state.dto';
import { P2pService } from './p2p.service';

@ApiTags('p2p')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('p2p')
export class P2pController {
  constructor(private readonly p2p: P2pService) {}

  @Post('availability')
  @ApiOperation({ summary: 'Advertise a locally cached, authorized CloudFusion file version' })
  advertiseAvailability(@Req() request: AuthenticatedRequest, @Body() dto: AdvertiseAvailabilityDto) {
    return this.p2p.advertiseAvailability(request.user.sub, request.user.deviceId, dto);
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
