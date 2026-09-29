import { All, Controller, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiTokenPrincipal } from '../api-tokens/api-token-scope';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';
import { VirtualDriveService, VirtualNodeResponse } from '../virtual-fs/virtual-drive.service';
import { WebDavAuthGuard } from './webdav-auth.guard';
import { WebDavPathService } from './webdav-path.service';
import { WebDavService } from './webdav.service';

type AuthenticatedWebDavRequest = Request & { apiTokenPrincipal: ApiTokenPrincipal };

const allow = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL';

@Controller()
@UseGuards(WebDavAuthGuard)
export class WebDavController {
  constructor(
    private readonly service: WebDavService,
    private readonly paths: WebDavPathService,
    private readonly virtualDrive: VirtualDriveService,
  ) {}

  @All('dav')
  root(@Req() request: AuthenticatedWebDavRequest, @Res() response: Response): Promise<void> {
    return this.dispatch(request, response);
  }

  @All('dav/*path')
  path(@Req() request: AuthenticatedWebDavRequest, @Res() response: Response): Promise<void> {
    return this.dispatch(request, response);
  }

  private async dispatch(request: AuthenticatedWebDavRequest, response: Response): Promise<void> {
    this.service.assertEnabled();
    const userId = request.apiTokenPrincipal.userId;
    const segments = this.paths.parsePath(request.originalUrl);
    switch (request.method.toUpperCase()) {
      case 'OPTIONS': return this.options(response);
      case 'PROPFIND': return this.propfind(request, response, userId, segments);
      case 'GET': return this.get(request, response, userId, segments, false);
      case 'HEAD': return this.get(request, response, userId, segments, true);
      case 'PUT': return this.put(request, response, userId, segments);
      case 'DELETE': await this.service.delete(userId, segments); response.status(204).end(); return;
      case 'MKCOL': await this.service.createCollection(userId, segments); response.status(201).end(); return;
      default: response.setHeader('Allow', allow).status(405).end();
    }
  }

  private options(response: Response): void {
    response.setHeader('Allow', allow);
    response.setHeader('DAV', '1');
    response.setHeader('MS-Author-Via', 'DAV');
    response.status(200).end();
  }

  private async propfind(request: Request, response: Response, userId: string, segments: string[]): Promise<void> {
    const depth = request.header('depth') ?? '1';
    const nodes = await this.service.propfind(userId, segments, depth);
    const xml = this.multistatus(nodes, segments);
    response.setHeader('DAV', '1');
    response.setHeader('Content-Type', 'application/xml; charset=utf-8');
    response.status(207).send(xml);
  }

  private async get(request: Request, response: Response, userId: string, segments: string[], headOnly: boolean): Promise<void> {
    const node = await this.service.resolve(userId, segments);
    if (node.type !== VirtualNodeType.FILE) {
      response.setHeader('Allow', 'OPTIONS, PROPFIND, HEAD, MKCOL');
      response.status(405).end();
      return;
    }
    const etag = this.service.etag(node);
    response.setHeader('ETag', etag);
    response.setHeader('Last-Modified', node.updatedAt.toUTCString());
    response.setHeader('Accept-Ranges', 'none');
    if (node.mimeType) response.setHeader('Content-Type', node.mimeType);
    if (node.size != null) response.setHeader('Content-Length', String(node.size));
    if (request.header('if-none-match') === etag) { response.status(304).end(); return; }
    if (headOnly) { response.status(200).end(); return; }
    await this.service.recordRead(userId, node);
    const file = await this.virtualDrive.download(userId, node.id);
    response.status(200);
    file.stream.once('error', () => response.destroy());
    file.stream.pipe(response);
  }

  private async put(request: Request, response: Response, userId: string, segments: string[]): Promise<void> {
    const tempPath = join(tmpdir(), 'cloudfusion-webdav', `${randomUUID()}.upload`);
    let size = 0;
    const maxBytes = this.service.maxUploadBytes();
    const contentLength = Number(request.header('content-length') ?? 0);
    if (contentLength > maxBytes) { response.status(413).end(); return; }
    await mkdir(dirname(tempPath), { recursive: true });
    try {
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > maxBytes) callback(new Error('WebDAV upload exceeds the configured size limit'));
          else callback(null, chunk);
        },
      });
      await pipeline(request, limiter, createWriteStream(tempPath, { flags: 'wx' }));
      const file = {
        fieldname: 'file',
        originalname: segments.at(-1) ?? '',
        encoding: '7bit',
        mimetype: String(request.header('content-type') ?? 'application/octet-stream').split(';', 1)[0],
        size,
        destination: dirname(tempPath),
        filename: basename(tempPath),
        path: tempPath,
      } as Express.Multer.File;
      const result = await this.service.put(userId, segments, file);
      response.setHeader('ETag', this.service.etag(result.node));
      response.status(result.created ? 201 : 204).end();
    } catch (error) {
      if (size > maxBytes) { response.status(413).end(); return; }
      throw error;
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  private multistatus(nodes: VirtualNodeResponse[], requestSegments: string[]): string {
    const responses = nodes.map((node, index) => {
      const segments = index === 0 ? requestSegments : [...requestSegments, node.name];
      const isFolder = node.type === VirtualNodeType.FOLDER;
      const href = this.paths.href(segments, isFolder);
      const resourceType = isFolder ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>';
      const length = !isFolder && node.size != null ? `<D:getcontentlength>${Number(node.size)}</D:getcontentlength>` : '';
      const contentType = !isFolder ? `<D:getcontenttype>${this.escapeXml(node.mimeType ?? 'application/octet-stream')}</D:getcontenttype>` : '';
      const lastModified = node.updatedAt.toUTCString();
      return `<D:response><D:href>${this.escapeXml(href)}</D:href><D:propstat><D:prop><D:displayname>${this.escapeXml(node.name)}</D:displayname>${resourceType}${length}${contentType}<D:getlastmodified>${lastModified}</D:getlastmodified><D:getetag>${this.escapeXml(this.service.etag(node))}</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
    });
    return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`;
  }

  private escapeXml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
  }
}
