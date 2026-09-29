import { UnauthorizedException } from '@nestjs/common';
import { UserRole, UserStatus } from '../../users/entities/user.entity';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy device sessions', () => {
  const user = {
    id: 'user-id',
    email: 'ana@example.com',
    username: 'ana_cloud',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
  };

  function strategy(isDeviceActive: boolean) {
    const users = { findById: jest.fn().mockResolvedValue(user) };
    const devices = { isActive: jest.fn().mockResolvedValue(isDeviceActive) };
    const config = { get: jest.fn().mockReturnValue('test-secret') };
    return { instance: new JwtStrategy(config as never, users as never, devices as never), devices };
  }

  it('preserves the verified device id in the authenticated principal', async () => {
    const { instance } = strategy(true);

    await expect(instance.validate({ sub: 'user-id', deviceId: 'device-id' } as never)).resolves.toMatchObject({
      sub: 'user-id',
      deviceId: 'device-id',
    });
  });

  it('rejects access tokens for a revoked device', async () => {
    const { instance, devices } = strategy(false);

    await expect(instance.validate({ sub: 'user-id', deviceId: 'device-id' } as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(devices.isActive).toHaveBeenCalledWith('user-id', 'device-id');
  });

  it('keeps existing non-device browser sessions backward compatible', async () => {
    const { instance, devices } = strategy(false);

    await expect(instance.validate({ sub: 'user-id' } as never)).resolves.toMatchObject({ sub: 'user-id' });
    expect(devices.isActive).not.toHaveBeenCalled();
  });
});
