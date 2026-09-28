import {
  INestApplication,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { AccessTokenGuard } from '../src/auth/guards/access-token.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';

class TestAccessTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const authorization = req.headers.authorization;
    if (!authorization) return false;
    req.user = { sub: 'user-id' };
    return authorization === 'Bearer valid-access-token';
  }
}

describe('AuthController (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  const authService = {
    register: jest.fn().mockResolvedValue({
      user: { id: 'user-id' },
      accessToken: 'a',
      refreshToken: 'r',
    }),
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn().mockResolvedValue({ loggedOut: true }),
    me: jest.fn().mockResolvedValue({ id: 'user-id' }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    })
      .overrideGuard(AccessTokenGuard)
      .useClass(TestAccessTokenGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    const httpServer: unknown = app.getHttpServer();
    server = httpServer as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows protected access with a valid token', async () => {
    await request(server)
      .get('/auth/me')
      .set('Authorization', 'Bearer valid-access-token')
      .expect(200)
      .expect(({ body }: { body: { data: { id: string } } }) =>
        expect(body.data.id).toBe('user-id'),
      );
  });

  it('rejects protected access without a token', async () => {
    await request(server).get('/auth/me').expect(403);
  });
});
