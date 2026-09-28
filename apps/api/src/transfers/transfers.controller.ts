import {
  Body,
  Controller,
  Delete,
  Get,
  MessageEvent,
  Param,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { TransferStatus } from './enums/transfer-status.enum';
import { TransferProgressService } from './transfer-progress.service';
import { TransferService } from './transfers.service';

@ApiTags('Transfers')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('transfers')
export class TransferController {
  constructor(
    private readonly service: TransferService,
    private readonly progress: TransferProgressService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Queue a cloud-to-cloud copy or move' })
  create(@Req() request: AuthenticatedRequest, @Body() dto: CreateTransferDto) {
    return this.service.create(request.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List the current user transfer history' })
  @ApiQuery({ name: 'status', required: false, enum: TransferStatus })
  list(@Req() request: AuthenticatedRequest, @Query('status') status?: TransferStatus) {
    return this.service.list(request.user.sub, status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one transfer owned by the current user' })
  get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.service.get(request.user.sub, id);
  }

  @Post(':id/retry')
  @ApiOperation({ summary: 'Retry a failed or cancelled transfer' })
  retry(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.service.retry(request.user.sub, id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a queued or active transfer' })
  cancel(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.service.cancel(request.user.sub, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a completed transfer history item' })
  remove(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.service.remove(request.user.sub, id);
  }

  @Sse(':id/events')
  @ApiOperation({ summary: 'Stream transfer progress events' })
  events(@Req() request: AuthenticatedRequest, @Param('id') id: string): Observable<MessageEvent> {
    return this.progress.events(request.user.sub, id);
  }
}
