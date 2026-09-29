import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { ApiTokenPrincipal, ApiTokenScope } from '../api-tokens/api-token-scope';
import { ApiTokensService } from '../api-tokens/api-tokens.service';

type WebDavRequest = Request & { apiTokenPrincipal?: ApiTokenPrincipal };

@Injectable()
export class WebDavAuthGuard implements CanActivate {
  constructor(private readonly tokens: ApiTokensService, private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WebDavRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const authorization = request.header('authorization') ?? '';
    const secure = request.secure || this.isLocalDevelopmentRequest(request);
    const basic = /^Basic\s+(.+)$/i.exec(authorization);
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization);

    response.setHeader('WWW-Authenticate', secure
      ? 'Bearer realm="CloudFusion WebDAV", Basic realm="CloudFusion WebDAV", charset="UTF-8"'
      : 'Bearer realm="CloudFusion WebDAV"');

    let rawToken: string;
    let expectedUserId: string | undefined;
    if (basic) {
      if (!request.secure) throw new UnauthorizedException('Basic authentication requires HTTPS');
      let credentials: string;
      try {
        credentials = Buffer.from(basic[1], 'base64').toString('utf8');
      } catch {
        throw new UnauthorizedException('Invalid WebDAV credentials');
      }
      const separator = credentials.indexOf(':');
      if (separator < 1) throw new UnauthorizedException('Invalid WebDAV credentials');
      expectedUserId = credentials.slice(0, separator);
      rawToken = credentials.slice(separator + 1);
    } else if (bearer) {
      if (!secure) throw new UnauthorizedException('WebDAV authentication requires HTTPS outside local development');
      rawToken = bearer[1];
    } else {
      throw new UnauthorizedException('A CloudFusion API token is required');
    }

    const principal = await this.tokens.verify(rawToken);
    if (expectedUserId && expectedUserId !== principal.userId) {
      throw new UnauthorizedException('WebDAV token does not belong to this user identifier');
    }
    const requiredScopes = this.scopesFor(request.method);
    if (requiredScopes.some((scope) => !principal.scopes.includes(scope))) {
      throw new ForbiddenException('API token does not have the required WebDAV scopes');
    }
    request.apiTokenPrincipal = principal;
    return true;
  }

  private scopesFor(method: string): ApiTokenScope[] {
    switch (method.toUpperCase()) {
      case 'OPTIONS': return [ApiTokenScope.WEBDAV];
      case 'PROPFIND':
      case 'GET':
      case 'HEAD': return [ApiTokenScope.WEBDAV, ApiTokenScope.FILES_READ];
      case 'PUT':
      case 'MKCOL': return [ApiTokenScope.WEBDAV, ApiTokenScope.FILES_WRITE];
      case 'DELETE': return [ApiTokenScope.WEBDAV, ApiTokenScope.FILES_DELETE];
      default: return [ApiTokenScope.WEBDAV];
    }
  }

  private isLocalDevelopmentRequest(request: Request): boolean {
    if (this.config.get<string>('app.nodeEnv') !== 'development') return false;
    const address = request.socket.remoteAddress ?? '';
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
  }
}
