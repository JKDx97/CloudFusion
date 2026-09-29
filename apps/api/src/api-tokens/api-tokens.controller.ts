import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CreateApiTokenDto } from './dto/create-api-token.dto';
import { ApiTokensService } from './api-tokens.service';

@ApiTags('api-tokens')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('api-tokens')
export class ApiTokensController {
  constructor(private readonly apiTokens: ApiTokensService) {}

  @Post()
  @ApiOperation({ summary: 'Create a scoped API token; the secret is returned only once' })
  create(@Req() request: AuthenticatedRequest, @Body() input: CreateApiTokenDto) {
    return this.apiTokens.create(request.user.sub, input);
  }

  @Get()
  @ApiOperation({ summary: 'List the current user’s API tokens without their secrets' })
  list(@Req() request: AuthenticatedRequest) {
    return this.apiTokens.list(request.user.sub);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke one of the current user’s API tokens' })
  revoke(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.apiTokens.revoke(request.user.sub, id);
  }
}
