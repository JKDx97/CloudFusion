import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { DevicePlatform } from './enums/device-platform.enum';
import { UserDevice } from './entities/user-device.entity';
import { DevicePairingCode } from './entities/device-pairing-code.entity';
import { StorageTarget } from '../providers/object-storage/entities/storage-target.entity';
import { DeviceStorageClass } from '../providers/object-storage/enums/device-storage-class.enum';
import { DeviceStorageStatus } from '../providers/object-storage/enums/device-storage-status.enum';

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
  let pairingCodes: {
    delete: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let pairingQueryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
  };
  let storageTargets: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };

  beforeEach(() => {
    repository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((value: Partial<UserDevice>) => ({
        ...device(),
        ...value,
      })),
      save: jest.fn(async (value: UserDevice) => value),
      createQueryBuilder: jest.fn(),
    };
    pairingQueryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [{ id: 'pairing-id', user_id: 'user-id' }] }),
    };
    pairingCodes = {
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((value: Partial<DevicePairingCode>) => value),
      save: jest.fn(async (value: DevicePairingCode) => ({
        ...value,
        id: 'pairing-id',
      })),
      createQueryBuilder: jest.fn(() => pairingQueryBuilder),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    storageTargets = {
      findOne: jest.fn(),
      create: jest.fn((value: Partial<StorageTarget>) => ({
        ...value,
        id: 'storage-target-id',
      })),
      save: jest.fn(async (value: StorageTarget) => value),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const manager = {
      getRepository: jest.fn((entity: typeof UserDevice | typeof StorageTarget) => (entity === UserDevice ? repository : storageTargets)),
    };
    dataSource = {
      transaction: jest.fn(async (work: (manager: typeof manager) => unknown) => work(manager)),
    };
    service = new DevicesService(repository as never, pairingCodes as never, audit as never, storageTargets as never, dataSource as never);
  });

  it('creates a five-minute pairing code and persists only its hash', async () => {
    const result = await service.createPairingCode('user-id');
    const saved = pairingCodes.save.mock.calls[0][0] as DevicePairingCode;

    expect(result.code).toMatch(/^[A-F0-9]{8}(-[A-F0-9]{8}){3}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    expect(saved.codeHash).toMatch(/^[a-f\d]{64}$/);
    expect(saved.codeHash).not.toContain(result.code.replace(/-/g, ''));
    expect(pairingCodes.delete).toHaveBeenCalledWith({
      expiresAt: expect.anything(),
    });
  });

  it('consumes a valid pairing code with one conditional database update', async () => {
    await expect(service.consumePairingCode('A1B2C3D4-E5F60718-192A3B4C-5D6E7F80')).resolves.toBe('user-id');

    expect(pairingQueryBuilder.update).toHaveBeenCalledWith(DevicePairingCode);
    expect(pairingQueryBuilder.where).toHaveBeenCalledWith(
      expect.stringContaining('"consumed_at" IS NULL AND "expires_at" > :now'),
      expect.objectContaining({
        codeHash: expect.stringMatching(/^[a-f\d]{64}$/),
        now: expect.any(Date),
      }),
    );
    expect(pairingQueryBuilder.returning).toHaveBeenCalledWith('*');
    expect(audit.record).toHaveBeenCalledWith('user-id', 'DEVICE_PAIRING_CODE_CONSUMED', 'DevicePairingCode', 'pairing-id');
  });

  it('rejects malformed, expired, or already consumed pairing codes without revealing which condition applied', async () => {
    await expect(service.consumePairingCode('not-a-pair-code')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(pairingCodes.createQueryBuilder).not.toHaveBeenCalled();

    pairingQueryBuilder.execute.mockResolvedValueOnce({ raw: [] });
    await expect(service.consumePairingCode('A1B2C3D4-E5F60718-192A3B4C-5D6E7F80')).rejects.toThrow('Device pairing code is invalid or expired');
  });

  it('allows at most one concurrent redemption of the same pairing code', async () => {
    pairingQueryBuilder.execute
      .mockResolvedValueOnce({
        raw: [{ id: 'pairing-id', user_id: 'user-id' }],
      })
      .mockResolvedValueOnce({ raw: [] });

    const results = await Promise.allSettled([service.consumePairingCode('A1B2C3D4-E5F60718-192A3B4C-5D6E7F80'), service.consumePairingCode('A1B2C3D4-E5F60718-192A3B4C-5D6E7F80')]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('registers one device identity and returns a sanitized record', async () => {
    repository.findOne.mockResolvedValue(null);
    repository.save.mockImplementation(async (value: UserDevice) => ({
      ...value,
      id: 'new-device-id',
    }));

    const result = await service.registerForAuthentication('user-id', {
      installationId: '4c1e7d65-0c17-4fac-a692-b48e6a12fb83',
      name: '  Sebastian-PC  ',
      platform: DevicePlatform.WINDOWS,
      clientVersion: '0.1.0',
    });

    expect(result).toMatchObject({
      id: 'new-device-id',
      userId: 'user-id',
      name: 'Sebastian-PC',
      p2pEnabled: false,
    });
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

    expect(repository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: [
          expect.objectContaining({
            userId: 'user-id',
            p2pEnabled: true,
            lanDiscoveryEnabled: true,
          }),
          expect.objectContaining({
            userId: 'user-id',
            p2pEnabled: true,
            internetP2pEnabled: true,
          }),
        ],
      }),
    );
  });

  it('does not allow a revoked installation to silently register again', async () => {
    repository.findOne.mockResolvedValue(device({ revokedAt: new Date() }));

    await expect(
      service.registerForAuthentication('user-id', {
        installationId: '4c1e7d65-0c17-4fac-a692-b48e6a12fb83',
        name: 'Sebastian-PC',
        platform: DevicePlatform.WINDOWS,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokes the refresh session and disables serving and storage contribution', async () => {
    const registeredDevice = device({
      p2pEnabled: true,
      internetP2pEnabled: true,
      serveLocalFiles: true,
      storageContributionEnabled: true,
    });
    repository.findOne.mockResolvedValue(registeredDevice);

    await expect(service.revoke('user-id', 'device-id')).resolves.toEqual({
      revoked: true,
    });

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        revokedAt: expect.any(Date),
        refreshTokenHash: null,
        p2pEnabled: false,
        internetP2pEnabled: false,
        serveLocalFiles: false,
        storageContributionEnabled: false,
      }),
    );
    expect(storageTargets.update).toHaveBeenCalledWith(
      { deviceId: 'device-id' },
      expect.objectContaining({
        enabled: false,
        availabilityStatus: DeviceStorageStatus.DISABLED,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith('user-id', 'DEVICE_REVOKED', 'UserDevice', 'device-id');
  });

  it('does not reveal devices belonging to another user', async () => {
    repository.findOne.mockResolvedValue(null);

    await expect(service.getActive('user-id', 'other-device')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.revoke('user-id', 'other-device')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps device storage disabled until the owner explicitly opts in with a capacity', async () => {
    repository.findOne.mockResolvedValue(device());
    storageTargets.findOne.mockResolvedValue(null);

    const result = await service.getStorageConfiguration('user-id', 'device-id');
    expect(result).toMatchObject({
      enabled: false,
      maxBytes: null,
      availabilityStatus: DeviceStorageStatus.DISABLED,
    });

    await expect(service.configureStorage('user-id', 'device-id', { enabled: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('configures an owned device storage target and records capacity as exact bytes', async () => {
    repository.findOne.mockResolvedValue(device());
    storageTargets.findOne.mockResolvedValue(null);

    const result = await service.configureStorage('user-id', 'device-id', {
      enabled: true,
      maxBytes: '10737418240',
      storageClass: DeviceStorageClass.ALWAYS_ON,
    });

    expect(result).toMatchObject({
      deviceId: 'device-id',
      enabled: true,
      maxBytes: '10737418240',
      usedBytes: '0',
      availableBytes: '10737418240',
      storageClass: DeviceStorageClass.ALWAYS_ON,
      availabilityStatus: DeviceStorageStatus.OFFLINE,
    });
    expect(storageTargets.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'DEVICE',
        deviceId: 'device-id',
        cloudAccountId: null,
        remoteIdentifier: null,
        enabled: true,
      }),
    );
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ storageContributionEnabled: true }));
    expect(audit.record).toHaveBeenCalledWith('user-id', 'DEVICE_STORAGE_CONFIGURED', 'StorageTarget', 'storage-target-id', expect.any(Object));
  });

  it('does not allow configuring storage for another user device', async () => {
    repository.findOne.mockResolvedValue(null);

    await expect(
      service.configureStorage('user-id', 'other-device', {
        enabled: true,
        maxBytes: '1000',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(storageTargets.save).not.toHaveBeenCalled();
  });

  it('rejects a capacity reduction below bytes already in use', async () => {
    repository.findOne.mockResolvedValue(device());
    storageTargets.findOne.mockResolvedValue({
      id: 'storage-target-id',
      deviceId: 'device-id',
      enabled: true,
      maxBytes: '1000',
      usedBytes: '800',
      availableBytes: '200',
      storageClass: DeviceStorageClass.VOLATILE,
      availabilityStatus: DeviceStorageStatus.ONLINE,
      lastSeenAt: new Date(),
    });

    await expect(service.configureStorage('user-id', 'device-id', { maxBytes: '799' })).rejects.toBeInstanceOf(BadRequestException);
    expect(storageTargets.save).not.toHaveBeenCalled();
  });

  it('only accepts a storage heartbeat from the device session itself', async () => {
    await expect(
      service.reportStorageHeartbeat('user-id', 'device-id', 'other-device', {
        usedBytes: '0',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('updates exact usage and online presence from a device-bound heartbeat', async () => {
    repository.findOne.mockResolvedValue(device({ storageContributionEnabled: true }));
    storageTargets.findOne.mockResolvedValue({
      id: 'storage-target-id',
      deviceId: 'device-id',
      enabled: true,
      maxBytes: '1000',
      usedBytes: '0',
      availableBytes: '1000',
      storageClass: DeviceStorageClass.VOLATILE,
      availabilityStatus: DeviceStorageStatus.OFFLINE,
      lastSeenAt: null,
    });

    const result = await service.reportStorageHeartbeat('user-id', 'device-id', 'device-id', { usedBytes: '417' });

    expect(result).toMatchObject({
      usedBytes: '417',
      availableBytes: '583',
      availabilityStatus: DeviceStorageStatus.ONLINE,
    });
    expect(storageTargets.save).toHaveBeenCalledWith(expect.objectContaining({ usedBytes: '417', availableBytes: '583' }));
  });

  it('rejects device-reported usage above its configured allocation', async () => {
    repository.findOne.mockResolvedValue(device({ storageContributionEnabled: true }));
    storageTargets.findOne.mockResolvedValue({
      id: 'storage-target-id',
      deviceId: 'device-id',
      enabled: true,
      maxBytes: '1000',
      usedBytes: '0',
      availableBytes: '1000',
      storageClass: DeviceStorageClass.VOLATILE,
      availabilityStatus: DeviceStorageStatus.OFFLINE,
      lastSeenAt: null,
    });

    await expect(
      service.reportStorageHeartbeat('user-id', 'device-id', 'device-id', {
        usedBytes: '1001',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storageTargets.save).not.toHaveBeenCalled();
  });

  it('reports a stale contributing device as offline without marking it missing', async () => {
    repository.findOne.mockResolvedValue(device());
    storageTargets.findOne.mockResolvedValue({
      id: 'storage-target-id',
      deviceId: 'device-id',
      enabled: true,
      maxBytes: '1000',
      usedBytes: '50',
      availableBytes: '950',
      storageClass: DeviceStorageClass.VOLATILE,
      availabilityStatus: DeviceStorageStatus.ONLINE,
      lastSeenAt: new Date(Date.now() - 4 * 60_000),
    });

    const result = await service.getStorageConfiguration('user-id', 'device-id');

    expect(result.availabilityStatus).toBe(DeviceStorageStatus.OFFLINE);
    expect(storageTargets.save).toHaveBeenCalledWith(expect.objectContaining({ availabilityStatus: DeviceStorageStatus.OFFLINE }));
    expect(Object.values(DeviceStorageStatus)).not.toContain('MISSING');
  });
});
