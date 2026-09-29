import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
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
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { CreateVirtualFolderDto } from '../virtual-fs/dto/create-virtual-folder.dto';
import { VirtualDriveService } from '../virtual-fs/virtual-drive.service';

const uploadDirectory = join(require('node:os').tmpdir(), 'cloudfusion-replication');
mkdirSync(uploadDirectory, { recursive: true });

@ApiTags('Workspace Drive')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('workspaces/:workspaceId/drive')
export class WorkspaceDriveController {
  constructor(private readonly drive: VirtualDriveService) {}

  @Get('root')
  @ApiOperation({ summary: 'Get the workspace drive root only for an active workspace member' })
  root(@Req() request: AuthenticatedRequest, @Param('workspaceId') workspaceId: string) {
    return this.drive.getWorkspaceRoot(request.user.sub, workspaceId);
  }

  @Get('nodes/:nodeId/children')
  @ApiOperation({ summary: 'List children of a folder in the requested workspace' })
  async children(@Req() request: AuthenticatedRequest, @Param('workspaceId') workspaceId: string, @Param('nodeId') nodeId: string) {
    await this.assertWorkspaceNode(request.user.sub, workspaceId, nodeId);
    return this.drive.getChildren(request.user.sub, nodeId);
  }

  @Post('folders')
  @ApiOperation({ summary: 'Create a folder inside a workspace drive' })
  async createFolder(@Req() request: AuthenticatedRequest, @Param('workspaceId') workspaceId: string, @Body() dto: CreateVirtualFolderDto) {
    const root = await this.drive.getWorkspaceRoot(request.user.sub, workspaceId);
    const parentId = dto.parentId ?? root.id;
    await this.assertWorkspaceNode(request.user.sub, workspaceId, parentId);
    return this.drive.createFolder(request.user.sub, { ...dto, parentId });
  }

  @Post('upload')
  @ApiOperation({ summary: 'Upload into a workspace drive using the workspace owner storage scope' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, parentId: { type: 'string' } } } })
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({ destination: uploadDirectory, filename: (_request, file, callback) => callback(null, `${Date.now()}-${randomBytes(8).toString('hex')}-${file.originalname}`) }),
    limits: { fileSize: Number(process.env.CLOUD_UPLOAD_MAX_BYTES ?? 52_428_800) },
  }))
  async upload(@Req() request: AuthenticatedRequest, @Param('workspaceId') workspaceId: string, @UploadedFile() file: Express.Multer.File, @Body('parentId') requestedParentId?: string) {
    const root = await this.drive.getWorkspaceRoot(request.user.sub, workspaceId);
    const parentId = requestedParentId ?? root.id;
    await this.assertWorkspaceNode(request.user.sub, workspaceId, parentId);
    return this.drive.upload(request.user.sub, file, parentId);
  }

  private async assertWorkspaceNode(userId: string, workspaceId: string, nodeId: string): Promise<void> {
    const node = await this.drive.getNode(userId, nodeId);
    if (node.workspaceId !== workspaceId) throw new NotFoundException('Workspace node not found');
  }
}
