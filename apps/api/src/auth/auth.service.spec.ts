import * as argon2 from 'argon2';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';

describe('AuthService', () => {
  const user = {
    id: 'user-id',
    email: 'ana@example.com',
    username: 'ana_cloud',
    passwordHash: '',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    refreshTokenHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as User;

  let service: AuthService;
  let usersService: {
    create: jest.Mock;
    findByEmail: jest.Mock;
    findByUsername: jest.Mock;
    findByEmailWithSecrets: jest.Mock;
    findById: jest.Mock;
    findByIdWithSecrets: jest.Mock;
    updateRefreshTokenHash: jest.Mock;
    toPublicUser: jest.Mock;
  };
  let jwtService: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(() => {
    usersService = {
      create: jest.fn(),
      findByEmail: jest.fn(),
      findByUsername: jest.fn(),
      findByEmailWithSecrets: jest.fn(),
      findById: jest.fn(),
      findByIdWithSecrets: jest.fn(),
      updateRefreshTokenHash: jest.fn().mockResolvedValue(undefined),
      toPublicUser: jest.fn((value: User) => value),
    };
    jwtService = {
      signAsync: jest
        .fn()
        .mockResolvedValueOnce('access-token')
        .mockResolvedValueOnce('refresh-token'),
      verifyAsync: jest.fn(),
    };
    configService = {
      get: jest.fn(
        (key: string) =>
          ({
            'jwt.accessSecret': 'access-secret',
            'jwt.refreshSecret': 'refresh-secret',
            'jwt.accessExpiration': '15m',
            'jwt.refreshExpiration': '7d',
          })[key],
      ),
    };
    service = new AuthService(
      usersService as never,
      jwtService as never,
      configService as never,
    );
  });

  it('registers a user and issues access and refresh tokens', async () => {
    usersService.create.mockImplementation(
      (_dto: unknown, passwordHash: string) => ({
        ...user,
        passwordHash,
      }),
    );

    const result = await service.register({
      email: 'ana@example.com',
      username: 'ana_cloud',
      password: 'CloudFusion123!',
    });

    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
    expect(usersService.create).toHaveBeenCalled();
    expect(usersService.updateRefreshTokenHash).toHaveBeenCalledWith(
      'user-id',
      expect.any(String),
    );
  });

  it('rejects duplicate email and username through the users service', async () => {
    usersService.create.mockRejectedValueOnce(
      new Error('Email already registered'),
    );

    await expect(
      service.register({
        email: 'ana@example.com',
        username: 'other',
        password: 'CloudFusion123!',
      }),
    ).rejects.toThrow('Email already registered');
  });

  it('rejects incorrect passwords', async () => {
    user.passwordHash = await argon2.hash('correct-password');
    usersService.findByEmailWithSecrets.mockResolvedValue(user);

    await expect(
      service.login({ email: 'ana@example.com', password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('logs in successfully with the correct password', async () => {
    user.passwordHash = await argon2.hash('correct-password');
    usersService.findByEmailWithSecrets.mockResolvedValue(user);

    const result = await service.login({
      email: 'ana@example.com',
      password: 'correct-password',
    });

    expect(result.user.id).toBe('user-id');
    expect(result.accessToken).toBe('access-token');
  });

  it('refreshes a valid refresh token and rejects an invalid one', async () => {
    const refreshToken = 'refresh-token';
    user.refreshTokenHash = await argon2.hash(refreshToken);
    usersService.findByIdWithSecrets.mockResolvedValue(user);
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'user-id',
      type: 'refresh',
    });

    await expect(service.refresh({ refreshToken })).resolves.toMatchObject({
      accessToken: 'access-token',
    });

    jwtService.verifyAsync.mockRejectedValueOnce(new Error('invalid'));
    await expect(
      service.refresh({ refreshToken: 'invalid' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
