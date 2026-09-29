import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';
import { VirtualNodeResponse, VirtualDriveService } from '../virtual-fs/virtual-drive.service';
import { WebDavPathService } from './webdav-path.service';

@Injectable()
export class WebDavService {
  constructor(
    private readonly drive: VirtualDriveService,
    private readonly paths: WebDavPathService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  assertEnabled(): void {
    if (this.config.get<boolean>('webdav.enabled') === false) {
      throw new ServiceUnavailableException('WebDAV is disabled');
    }
  }

  maxUploadBytes(): number {
    return this.config.get<number>('cloud.uploadMaxBytes') ?? 52_428_800;
  }

  async resolve(userId: string, segments: string[]): Promise<VirtualNodeResponse> {
    const node = await this.paths.resolve(userId, segments);
    if (!node) throw new NotFoundException('WebDAV resource not found');
    return node;
  }

  async propfind(userId: string, segments: string[], depth: string): Promise<VirtualNodeResponse[]> {
    if (depth !== '0' && depth !== '1') throw new ForbiddenException('WebDAV supports Depth 0 or 1 only');
    const target = await this.resolve(userId, segments);
    if (depth === '0' || target.type !== VirtualNodeType.FOLDER) return [target];
    return [target, ...await this.drive.getChildren(userId, target.id)];
  }

  async put(userId: string, segments: string[], file: Express.Multer.File): Promise<{ node: VirtualNodeResponse; created: boolean }> {
    if (segments.length === 0) throw new BadRequestException('A file name is required');
    const name = segments.at(-1)!;
    const parent = await this.paths.resolveParent(userId, segments);
    if (!parent || parent.type !== VirtualNodeType.FOLDER) throw new ConflictException('WebDAV parent folder does not exist');
    const existing = await this.paths.resolve(userId, segments);
    if (existing && existing.type !== VirtualNodeType.FILE) throw new ConflictException('A folder already exists at this path');
    const result = existing
      ? await this.drive.uploadVersion(userId, existing.id, file)
      : await this.drive.upload(userId, { ...file, originalname: name } as Express.Multer.File, parent.id);
    await this.audit.record(userId, 'WEBDAV_FILE_WRITE', 'VirtualNode', result.node.id, { versionId: result.node.currentVersionId });
    return { node: result.node, created: !existing };
  }

  async createCollection(userId: string, segments: string[]): Promise<VirtualNodeResponse> {
    if (segments.length === 0) throw new ConflictException('The CloudFusion Drive root already exists');
    if (await this.paths.resolve(userId, segments)) throw new ConflictException('WebDAV resource already exists');
    const parent = await this.paths.resolveParent(userId, segments);
    if (!parent || parent.type !== VirtualNodeType.FOLDER) throw new ConflictException('WebDAV parent folder does not exist');
    const folder = await this.drive.createFolder(userId, { name: segments.at(-1)!, parentId: parent.id });
    await this.audit.record(userId, 'WEBDAV_FOLDER_CREATE', 'VirtualNode', folder.id, { parentId: parent.id });
    return folder;
  }

  async delete(userId: string, segments: string[]): Promise<void> {
    if (segments.length === 0) throw new ConflictException('The CloudFusion Drive root cannot be deleted');
    const node = await this.resolve(userId, segments);
    await this.drive.trash(userId, node.id);
    await this.audit.record(userId, 'WEBDAV_FILE_DELETE', 'VirtualNode', node.id, { type: node.type });
  }

  async recordRead(userId: string, node: VirtualNodeResponse): Promise<void> {
    await this.audit.record(userId, 'WEBDAV_FILE_READ', 'VirtualNode', node.id, { versionId: node.currentVersionId });
  }

  etag(node: VirtualNodeResponse): string {
    const version = node.currentVersionId ?? `${node.id}-${node.updatedAt.getTime()}`;
    return `"cf-${version}"`;
  }
}
