import { Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { UsersService, PublicUser } from '../users/users.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { PairDeviceDto } from './dto/pair-device.dto';
import { JwtUser } from './types/jwt-user';
import { DevicesService } from '../devices/devices.service';
import { RegisterDeviceDto } from '../devices/dto/register-device.dto';

export interface AuthResponse {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  deviceId?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    @Optional() private readonly devices?: DevicesService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const passwordHash = await argon2.hash(dto.password);
    const user = await this.usersService.create(dto, passwordHash);
    const device = dto.device ? await this.registerDevice(user.id, dto.device) : undefined;
    const tokens = await this.issueTokens(user, device?.id);
    this.logger.log(
      JSON.stringify({ event: 'auth.registration.completed', userId: user.id }),
    );
    return { user: this.usersService.toPublicUser(user), ...tokens, ...(device ? { deviceId: device.id } : {}) };
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

    const device = dto.device ? await this.registerDevice(user.id, dto.device) : undefined;
    const tokens = await this.issueTokens(user, device?.id);
    this.logger.log(
      JSON.stringify({ event: 'auth.login.succeeded', userId: user.id }),
    );
    return { user: this.usersService.toPublicUser(user), ...tokens, ...(device ? { deviceId: device.id } : {}) };
  }

  async createDevicePairingCode(userId: string): Promise<{ code: string; expiresAt: Date }> {
    if (!this.devices) throw new UnauthorizedException('Device pairing is unavailable');
    return this.devices.createPairingCode(userId);
  }

  async pairDevice(dto: PairDeviceDto): Promise<AuthResponse> {
    if (!this.devices) throw new UnauthorizedException('Device pairing is unavailable');
    const userId = await this.devices.consumePairingCode(dto.code);
    const user = await this.usersService.findByIdWithSecrets(userId);
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Device pairing code is invalid or expired');
    }

    const device = await this.registerDevice(userId, dto.device);
    const tokens = await this.issueTokens(user, device.id);
    this.logger.log(JSON.stringify({ event: 'auth.device_pairing.completed', userId, deviceId: device.id }));
    return { user: this.usersService.toPublicUser(user), ...tokens, deviceId: device.id };
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
    const storedTokenHash = payload.deviceId
      ? await this.devices?.getRefreshTokenHash(payload.sub, payload.deviceId)
      : user?.refreshTokenHash;
    const validStoredToken = storedTokenHash
      ? await argon2.verify(storedTokenHash, dto.refreshToken)
      : false;
    if (!user || user.status !== UserStatus.ACTIVE || !validStoredToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokens = await this.issueTokens(user, payload.deviceId);
    return { user: this.usersService.toPublicUser(user), ...tokens, ...(payload.deviceId ? { deviceId: payload.deviceId } : {}) };
  }

  async logout(userId: string, deviceId?: string): Promise<{ loggedOut: true }> {
    if (deviceId) await this.devices?.updateRefreshTokenHash(userId, deviceId, null);
    else await this.usersService.updateRefreshTokenHash(userId, null);
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
    deviceId?: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const basePayload: JwtUser = {
      sub: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      ...(deviceId ? { deviceId } : {}),
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
    if (deviceId) {
      if (!this.devices) throw new UnauthorizedException('Device sessions are unavailable');
      await this.devices.updateRefreshTokenHash(user.id, deviceId, refreshTokenHash);
    } else {
      await this.usersService.updateRefreshTokenHash(user.id, refreshTokenHash);
    }
    return { accessToken, refreshToken };
  }

  private async registerDevice(userId: string, device: RegisterDeviceDto) {
    if (!this.devices) throw new UnauthorizedException('Device registration is unavailable');
    return this.devices.registerForAuthentication(userId, device);
  }
}
