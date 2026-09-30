import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { DevicePlatform } from './enums/device-platform.enum';
import { UserDevice } from './entities/user-device.entity';

function device(overrides: Partial<UserDevice> = {}): UserDevice {
  return {
    id: 'device-id',
    userId: 'user-id',
    installationId: '4c1e7d65-0c17-4fac-a692-b48e6a12fb83',
    name: 'Sebastian-PC',
    platform: DevicePlatform.WINDOWS,
    clientVersion: '0.1.0',
    peerId: null,
    peerPublicKey: null,
    refreshTokenHash: 'hashed-refresh-token',
    p2pEnabled: false,
    lanDiscoveryEnabled: true,
    internetP2pEnabled: false,
    relayAllowed: true,
    serveLocalFiles: false,
    storageContributionEnabled: false,
    lastSeenAt: new Date('2026-09-29T00:00:00.000Z'),
    revokedAt: null,
    createdAt: new Date('2026-09-28T00:00:00.000Z'),
    updatedAt: new Date('2026-09-28T00:00:00.000Z'),
    ...overrides,
  };
}

describe('DevicesService', () => {
  let service: DevicesService;
  let repository: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let audit: { record: jest.Mock };

  beforeEach(() => {
    repository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((value: Partial<UserDevice>) => ({ ...device(), ...value })),
      save: jest.fn(async (value: UserDevice) => value),
      createQueryBuilder: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new DevicesService(repository as never, audit as never);
  });

  it('registers one device identity and returns a sanitized record', async () => {
    repository.findOne.mockResolvedValue(null);
    repository.save.mockImplementation(async (value: UserDevice) => ({ ...value, id: 'new-device-id' }));

    const result = await service.registerForAuthentication('user-id', {
      installationId: '4c1e7d65-0c17-4fac-a692-b48e6a12fb83',
      name: '  Sebastian-PC  ',
      platform: DevicePlatform.WINDOWS,
      clientVersion: '0.1.0',
    });

    expect(result).toMatchObject({ id: 'new-device-id', userId: 'user-id', name: 'Sebastian-PC', p2pEnabled: false });
    expect(audit.record).toHaveBeenCalledWith('user-id', 'DEVICE_REGISTERED', 'UserDevice', 'new-device-id', { platform: DevicePlatform.WINDOWS });
  });

  it('does not disclose the installation identifier, key material, or refresh-token hash', async () => {
    repository.find.mockResolvedValue([device()]);

    const [result] = await service.list('user-id');

    expect(result).not.toHaveProperty('installationId');
    expect(result).not.toHaveProperty('peerPublicKey');
    expect(result).not.toHaveProperty('refreshTokenHash');
  });

  it('lists enabled peers for either LAN discovery or Internet P2P', async () => {
    repository.find.mockResolvedValue([]);

    await service.listMeshPeers('user-id');

    expect(repository.find).toHaveBeenCalledWith(expect.objectContaining({
      where: [
        expect.objectContaining({ userId: 'user-id', p2pEnabled: true, lanDiscoveryEnabled: true }),
        expect.objectContaining({ userId: 'user-id', p2pEnabled: true, internetP2pEnabled: true }),
      ],
    }));
  });

  it('does not allow a revoked installation to silently register again', async () => {
    repository.findOne.mockResolvedValue(device({ revokedAt: new Date() }));

    await expect(service.registerForAuthentication('user-id', {
      installationId: '4c1e7d65-0c17-4fac-a692-b48e6a12fb83',
      name: 'Sebastian-PC',
      platform: DevicePlatform.WINDOWS,
    })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokes the refresh session and disables serving and storage contribution', async () => {
    const registeredDevice = device({ p2pEnabled: true, internetP2pEnabled: true, serveLocalFiles: true, storageContributionEnabled: true });
    repository.findOne.mockResolvedValue(registeredDevice);

    await expect(service.revoke('user-id', 'device-id')).resolves.toEqual({ revoked: true });

    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      revokedAt: expect.any(Date),
      refreshTokenHash: null,
      p2pEnabled: false,
      internetP2pEnabled: false,
      serveLocalFiles: false,
      storageContributionEnabled: false,
    }));
    expect(audit.record).toHaveBeenCalledWith('user-id', 'DEVICE_REVOKED', 'UserDevice', 'device-id');
  });

  it('does not reveal devices belonging to another user', async () => {
    repository.findOne.mockResolvedValue(null);

    await expect(service.getActive('user-id', 'other-device')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.revoke('user-id', 'other-device')).rejects.toBeInstanceOf(NotFoundException);
  });
});
