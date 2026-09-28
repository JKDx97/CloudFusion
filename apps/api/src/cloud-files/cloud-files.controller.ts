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
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Response } from 'express';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CloudFilesService } from './cloud-files.service';
import { CreateFolderDto } from './dto/create-folder.dto';
import { RenameItemDto } from './dto/rename-item.dto';

const uploadDirectory = join(tmpdir(), 'cloudfusion-uploads');
mkdirSync(uploadDirectory, { recursive: true });

@ApiTags('Cloud Files')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('cloud-files')
export class CloudFilesController {
  constructor(private readonly service: CloudFilesService) {}

  @Get()
  @ApiOperation({ summary: 'List files from one account or all connected accounts' })
  @ApiQuery({ name: 'accountId', required: false })
  @ApiQuery({ name: 'parentId', required: false })
  list(@Req() request: AuthenticatedRequest, @Query('accountId') accountId?: string, @Query('parentId') parentId?: string) {
    return this.service.list(request.user.sub, accountId, parentId);
  }

  @Get(':accountId/:fileId/download')
  @ApiOperation({ summary: 'Stream a file through CloudFusion' })
  async download(@Req() request: AuthenticatedRequest, @Param('accountId') accountId: string, @Param('fileId') fileId: string, @Res() response: Response): Promise<void> {
    const file = await this.service.download(request.user.sub, accountId, fileId);
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.fileName)}"`);
    if (file.mimeType) response.setHeader('Content-Type', file.mimeType);
    if (file.size != null) response.setHeader('Content-Length', String(file.size));
    file.stream.pipe(response);
  }

  @Get(':accountId/:fileId')
  @ApiOperation({ summary: 'Get one normalized cloud file' })
  get(@Req() request: AuthenticatedRequest, @Param('accountId') accountId: string, @Param('fileId') fileId: string) {
    return this.service.get(request.user.sub, accountId, fileId);
  }

  @Get(':accountId')
  @ApiOperation({ summary: 'List one account folder' })
  @ApiParam({ name: 'accountId' })
  listAccount(@Req() request: AuthenticatedRequest, @Param('accountId') accountId: string, @Query('parentId') parentId?: string) {
    return this.service.list(request.user.sub, accountId, parentId);
  }

  @Post(':accountId/upload')
  @ApiOperation({ summary: 'Upload a file without exposing provider tokens' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, parentId: { type: 'string' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: diskStorage({ destination: uploadDirectory, filename: (_request, file, callback) => callback(null, `${Date.now()}-${randomBytes(8).toString('hex')}-${file.originalname}`) }), limits: { fileSize: Number(process.env.CLOUD_UPLOAD_MAX_BYTES ?? 52_428_800) } }))
  upload(@Req() request: AuthenticatedRequest, @Param('accountId') accountId: string, @UploadedFile() file: Express.Multer.File, @Body('parentId') parentId?: string) {
    return this.service.upload(request.user.sub, accountId, file, parentId);
  }

  @Post('smart-upload')
  @ApiOperation({ summary: 'Upload using the user smart storage rules and available quota' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, parentId: { type: 'string' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: diskStorage({ destination: uploadDirectory, filename: (_request, file, callback) => callback(null, `${Date.now()}-${randomBytes(8).toString('hex')}-${file.originalname}`) }), limits: { fileSize: Number(process.env.CLOUD_UPLOAD_MAX_BYTES ?? 52_428_800) } }))
  smartUpload(@Req() request: AuthenticatedRequest, @UploadedFile() file: Express.Multer.File, @Body('parentId') parentId?: string) {
    return this.service.smartUpload(request.user.sub, file, parentId);
  }

  @Post(':accountId/folders')
  @ApiOperation({ summary: 'Create a remote folder' })
  createFolder(@Req() request: AuthenticatedRequest, @Param('accountId') accountId: string, @Body() dto: CreateFolderDto) {
    return this.service.createFolder(request.user.sub, accountId, dto);
  }

  @Patch(':accountId/:fileId')
  @ApiOperation({ summary: 'Rename a remote file or folder' })
  rename(@Req() request: AuthenticatedRequest, @Param('accountId') accountId: string, @Param('fileId') fileId: string, @Body() dto: RenameItemDto) {
    return this.service.rename(request.user.sub, accountId, fileId, dto.name);
  }

  @Delete(':accountId/:fileId')
  @ApiOperation({ summary: 'Delete a remote file or folder' })
  delete(@Req() request: AuthenticatedRequest, @Param('accountId') accountId: string, @Param('fileId') fileId: string) {
    return this.service.delete(request.user.sub, accountId, fileId);
  }
}
