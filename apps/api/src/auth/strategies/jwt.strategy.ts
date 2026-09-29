import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserStatus } from '../../users/entities/user.entity';
import { UsersService } from '../../users/users.service';
import { JwtUser } from '../types/jwt-user';
import { DevicesService } from '../../devices/devices.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly usersService: UsersService,
    @Optional() private readonly devices?: DevicesService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret') ?? '',
    });
  }

  async validate(payload: JwtUser): Promise<JwtUser> {
    const user = await this.usersService.findById(payload.sub);
    if (!user || user.status !== UserStatus.ACTIVE)
      throw new UnauthorizedException('Invalid access token');
    if (payload.deviceId && !(await this.devices?.isActive(user.id, payload.deviceId))) {
      throw new UnauthorizedException('Device session has been revoked');
    }

    return {
      sub: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
    };
  }
}
