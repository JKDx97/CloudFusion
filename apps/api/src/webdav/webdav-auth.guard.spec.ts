import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiTokenPrincipal, ApiTokenScope } from '../api-tokens/api-token-scope';
import { WebDavAuthGuard } from './webdav-auth.guard';

describe('WebDavAuthGuard', () => {
  const principal: ApiTokenPrincipal = {
    userId: 'user-1', tokenId: 'token-1', scopes: [ApiTokenScope.WEBDAV, ApiTokenScope.FILES_READ],
  };
  const makeContext = (method: string, authorization: string, secure = false): { context: ExecutionContext; request: Record<string, unknown>; response: { setHeader: jest.Mock } } => {
    const request = {
      method,
      secure,
      socket: { remoteAddress: '127.0.0.1' },
      header: jest.fn((name: string) => name.toLowerCase() === 'authorization' ? authorization : undefined),
    };
    const response = { setHeader: jest.fn() };
    const context = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ExecutionContext;
    return { context, request, response };
  };

  it('accepts a scoped bearer token from localhost during development', async () => {
    const tokens = { verify: jest.fn().mockResolvedValue(principal) };
    const config = { get: jest.fn().mockReturnValue('development') };
    const guard = new WebDavAuthGuard(tokens as never, config as never);
    const { context, request, response } = makeContext('PROPFIND', 'Bearer cf_live_test');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(tokens.verify).toHaveBeenCalledWith('cf_live_test');
    expect(request.apiTokenPrincipal).toEqual(principal);
    expect(response.setHeader).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('Bearer'));
  });

  it('enforces the write scope separately from the WebDAV scope', async () => {
    const tokens = { verify: jest.fn().mockResolvedValue(principal) };
    const config = { get: jest.fn().mockReturnValue('development') };
    const guard = new WebDavAuthGuard(tokens as never, config as never);
    const { context } = makeContext('PUT', 'Bearer cf_live_test');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('never accepts Basic credentials over plain HTTP', async () => {
    const tokens = { verify: jest.fn() };
    const config = { get: jest.fn().mockReturnValue('development') };
    const guard = new WebDavAuthGuard(tokens as never, config as never);
    const credentials = Buffer.from('user-1:cf_live_secret').toString('base64');
    const { context } = makeContext('GET', `Basic ${credentials}`);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.verify).not.toHaveBeenCalled();
  });

  it('requires TLS for bearer credentials outside local development', async () => {
    const tokens = { verify: jest.fn() };
    const config = { get: jest.fn().mockReturnValue('production') };
    const guard = new WebDavAuthGuard(tokens as never, config as never);
    const { context } = makeContext('GET', 'Bearer cf_live_test');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.verify).not.toHaveBeenCalled();
  });
});
