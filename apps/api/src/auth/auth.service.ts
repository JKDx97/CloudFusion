import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { UsersService, PublicUser } from '../users/users.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtUser } from './types/jwt-user';

export interface AuthResponse {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const passwordHash = await argon2.hash(dto.password);
    const user = await this.usersService.create(dto, passwordHash);
    const tokens = await this.issueTokens(user);
    this.logger.log(
      JSON.stringify({ event: 'auth.registration.completed', userId: user.id }),
    );
    return { user: this.usersService.toPublicUser(user), ...tokens };
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const user = await this.usersService.findByEmailWithSecrets(dto.email);
    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      !(await argon2.verify(user.passwordHash, dto.password))
    ) {
      this.logger.warn(
        JSON.stringify({
          event: 'auth.login.failed',
          reason: 'invalid_credentials',
        }),
      );
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.issueTokens(user);
    this.logger.log(
      JSON.stringify({ event: 'auth.login.succeeded', userId: user.id }),
    );
    return { user: this.usersService.toPublicUser(user), ...tokens };
  }

  async refresh(dto: RefreshTokenDto): Promise<AuthResponse> {
    let payload: JwtUser;
    try {
      payload = await this.jwtService.verifyAsync<JwtUser>(dto.refreshToken, {
        secret: this.config.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.type !== 'refresh' || !payload.sub)
      throw new UnauthorizedException('Invalid refresh token');

    const user = await this.usersService.findByIdWithSecrets(payload.sub);
    const validStoredToken = user?.refreshTokenHash
      ? await argon2.verify(user.refreshTokenHash, dto.refreshToken)
      : false;
    if (!user || user.status !== UserStatus.ACTIVE || !validStoredToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokens = await this.issueTokens(user);
    return { user: this.usersService.toPublicUser(user), ...tokens };
  }

  async logout(userId: string): Promise<{ loggedOut: true }> {
    await this.usersService.updateRefreshTokenHash(userId, null);
    return { loggedOut: true };
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.usersService.findById(userId);
    if (!user || user.status !== UserStatus.ACTIVE)
      throw new UnauthorizedException('User is not active');
    return this.usersService.toPublicUser(user);
  }

  private async issueTokens(
    user: User,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const basePayload: JwtUser = {
      sub: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };
    const accessToken = await this.jwtService.signAsync(basePayload, {
      secret: this.config.get<string>('jwt.accessSecret'),
      expiresIn: this.config.get<string>(
        'jwt.accessExpiration',
      ) as JwtSignOptions['expiresIn'],
    });
    const refreshToken = await this.jwtService.signAsync(
      { ...basePayload, type: 'refresh' },
      {
        secret: this.config.get<string>('jwt.refreshSecret'),
        expiresIn: this.config.get<string>(
          'jwt.refreshExpiration',
        ) as JwtSignOptions['expiresIn'],
      },
    );
    const refreshTokenHash = await argon2.hash(refreshToken);
    await this.usersService.updateRefreshTokenHash(user.id, refreshTokenHash);
    return { accessToken, refreshToken };
  }
}
