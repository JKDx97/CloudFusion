import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Response } from 'express';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CreateVirtualFolderDto } from './dto/create-virtual-folder.dto';
import { MoveVirtualNodeDto } from './dto/move-virtual-node.dto';
import { UpdateVirtualNodeDto } from './dto/update-virtual-node.dto';
import { VirtualDriveService } from './virtual-drive.service';

const uploadDirectory = join(require('node:os').tmpdir(), 'cloudfusion-replication');
mkdirSync(uploadDirectory, { recursive: true });

@ApiTags('Virtual Drive')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('virtual-drive')
export class VirtualDriveController {
  constructor(private readonly service: VirtualDriveService) {}

  @Get('root')
  @ApiOperation({ summary: 'Get or initialize the authenticated user drive root' })
  root(@Req() request: AuthenticatedRequest) { return this.service.getRoot(request.user.sub); }

  @Get('nodes/:id/children')
  @ApiOperation({ summary: 'List virtual children from the metadata index' })
  children(@Req() request: AuthenticatedRequest, @Param('id') id: string) { return this.service.getChildren(request.user.sub, id); }

  @Get('nodes/:id')
  @ApiOperation({ summary: 'Get one owned virtual node' })
  node(@Req() request: AuthenticatedRequest, @Param('id') id: string) { return this.service.getNode(request.user.sub, id); }

  @Get('nodes/:id/download')
  @ApiOperation({ summary: 'Download a virtual file using healthy replica failover' })
  async download(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Res() response: Response): Promise<void> {
    const file = await this.service.download(request.user.sub, id);
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.fileName)}"`);
    if (file.mimeType) response.setHeader('Content-Type', file.mimeType);
    if (file.size != null) response.setHeader('Content-Length', String(file.size));
    file.stream.pipe(response);
  }

  @Post('folders')
  @ApiOperation({ summary: 'Create a metadata-only virtual folder' })
  folder(@Req() request: AuthenticatedRequest, @Body() dto: CreateVirtualFolderDto) { return this.service.createFolder(request.user.sub, dto); }

  @Post('upload')
  @ApiOperation({ summary: 'Create a logical file and queue its physical replicas' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, parentId: { type: 'string' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: diskStorage({ destination: uploadDirectory, filename: (_request, file, callback) => callback(null, `${Date.now()}-${randomBytes(8).toString('hex')}-${file.originalname}`) }), limits: { fileSize: Number(process.env.CLOUD_UPLOAD_MAX_BYTES ?? 52_428_800) } }))
  upload(@Req() request: AuthenticatedRequest, @UploadedFile() file: Express.Multer.File, @Body('parentId') parentId?: string) { return this.service.upload(request.user.sub, file, parentId); }

  @Patch('nodes/:id')
  @ApiOperation({ summary: 'Rename a virtual node without touching provider objects' })
  rename(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpdateVirtualNodeDto) { return this.service.rename(request.user.sub, id, dto); }

  @Post('nodes/:id/move')
  @ApiOperation({ summary: 'Move a virtual node by changing metadata only' })
  move(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() dto: MoveVirtualNodeDto) { return this.service.move(request.user.sub, id, dto); }

  @Delete('nodes/:id')
  @ApiOperation({ summary: 'Move a virtual node to trash' })
  trash(@Req() request: AuthenticatedRequest, @Param('id') id: string) { return this.service.trash(request.user.sub, id); }

  @Post('nodes/:id/restore')
  @ApiOperation({ summary: 'Restore a virtual node from trash' })
  restore(@Req() request: AuthenticatedRequest, @Param('id') id: string) { return this.service.restore(request.user.sub, id); }

  @Delete('nodes/:id/permanent')
  @ApiOperation({ summary: 'Permanently delete a trashed virtual node' })
  permanent(@Req() request: AuthenticatedRequest, @Param('id') id: string) { return this.service.permanentDelete(request.user.sub, id); }

  @Get('recent')
  @ApiOperation({ summary: 'List recently accessed virtual nodes' })
  recent(@Req() request: AuthenticatedRequest) { return this.service.recent(request.user.sub); }

  @Get('favorites')
  @ApiOperation({ summary: 'List favorite virtual nodes' })
  favorites(@Req() request: AuthenticatedRequest) { return this.service.favorites(request.user.sub); }

  @Post('nodes/:id/favorite')
  @ApiOperation({ summary: 'Mark a virtual node as favorite' })
  favorite(@Req() request: AuthenticatedRequest, @Param('id') id: string) { return this.service.setFavorite(request.user.sub, id, true); }

  @Delete('nodes/:id/favorite')
  @ApiOperation({ summary: 'Remove a virtual node from favorites' })
  unfavorite(@Req() request: AuthenticatedRequest, @Param('id') id: string) { return this.service.setFavorite(request.user.sub, id, false); }

  @Get('children')
  @ApiOperation({ summary: 'List children from root when no parent route is available' })
  childrenFromRoot(@Req() request: AuthenticatedRequest, @Query('parentId') parentId?: string) { return this.service.getChildren(request.user.sub, parentId); }
}
