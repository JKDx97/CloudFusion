import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CreateStorageRuleDto } from './dto/create-storage-rule.dto';
import { UpdateStorageRuleDto } from './dto/update-storage-rule.dto';
import { StorageRuleService } from './storage-rule.service';

@ApiTags('Storage Rules')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('storage-rules')
export class StorageRulesController {
  constructor(private readonly service: StorageRuleService) {}

  @Get()
  @ApiOperation({ summary: 'List smart storage rules' })
  list(@Req() request: AuthenticatedRequest) { return this.service.list(request.user.sub); }

  @Post()
  @ApiOperation({ summary: 'Create a smart storage rule' })
  create(@Req() request: AuthenticatedRequest, @Body() dto: CreateStorageRuleDto) { return this.service.create(request.user.sub, dto); }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit, enable, disable, or reprioritize a rule' })
  update(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpdateStorageRuleDto) { return this.service.update(request.user.sub, id, dto); }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a smart storage rule' })
  remove(@Req() request: AuthenticatedRequest, @Param('id') id: string) { return this.service.remove(request.user.sub, id); }
}
