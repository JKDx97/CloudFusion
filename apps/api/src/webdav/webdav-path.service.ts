import { BadRequestException, Injectable } from '@nestjs/common';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';
import { VirtualNodeResponse, VirtualDriveService } from '../virtual-fs/virtual-drive.service';

@Injectable()
export class WebDavPathService {
  constructor(private readonly drive: VirtualDriveService) {}

  parsePath(rawUrl: string): string[] {
    const pathname = rawUrl.split('?', 1)[0];
    if (pathname !== '/dav' && !pathname.startsWith('/dav/')) {
      throw new BadRequestException('WebDAV paths must stay below /dav');
    }
    const relative = pathname.slice('/dav'.length);
    const segments: string[] = [];
    for (const rawSegment of relative.split('/').filter(Boolean)) {
      let segment: string;
      try {
        segment = decodeURIComponent(rawSegment);
      } catch {
        throw new BadRequestException('Malformed WebDAV path encoding');
      }
      if (!segment || segment === '.' || segment === '..' || /[\\/\u0000-\u001f\u007f]/.test(segment)) {
        throw new BadRequestException('Invalid WebDAV path segment');
      }
      segments.push(segment);
    }
    return segments;
  }

  async resolve(userId: string, segments: string[]): Promise<VirtualNodeResponse | null> {
    let node = await this.drive.getRoot(userId);
    for (const name of segments) {
      if (node.type !== VirtualNodeType.FOLDER) return null;
      const children = await this.drive.getChildren(userId, node.id);
      const child = children.find((candidate) => candidate.name === name);
      if (!child) return null;
      node = child;
    }
    return node;
  }

  async resolveParent(userId: string, segments: string[]): Promise<VirtualNodeResponse | null> {
    if (segments.length === 0) return null;
    return this.resolve(userId, segments.slice(0, -1));
  }

  href(segments: string[], isFolder: boolean): string {
    const path = segments.length === 0
      ? '/dav'
      : `/dav/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
    const normalized = path.replace(/\/$/, '');
    return isFolder ? `${normalized}/` : normalized;
  }
}
