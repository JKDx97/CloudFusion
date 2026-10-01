import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, IsNull, LessThan, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { DeviceFileAvailability, DeviceFileAvailabilityStatus } from '../p2p/entities/device-file-availability.entity';
import { DeviceStorageReplica, DeviceStorageReplicaStatus } from '../p2p/entities/device-storage-replica.entity';
import { StorageTarget } from '../providers/object-storage/entities/storage-target.entity';
import { DeviceStorageClass } from '../providers/object-storage/enums/device-storage-class.enum';
import { DeviceStorageStatus } from '../providers/object-storage/enums/device-storage-status.enum';
import { ConfigureDeviceStorageDto } from './dto/configure-device-storage.dto';
import { ReportDeviceStorageDto } from './dto/report-device-storage.dto';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { UpdateDeviceSettingsDto } from './dto/update-device-settings.dto';
import { DevicePairingCode } from './entities/device-pairing-code.entity';
import { UserDevice } from './entities/user-device.entity';
import { isMatchingEd25519PeerIdentity } from './peer-identity';

export type PublicDevice = Omit<UserDevice, 'installationId' | 'refreshTokenHash' | 'peerPublicKey'>;
const DEVICE_PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const DEVICE_STORAGE_HEARTBEAT_TTL_MS = 3 * 60 * 1000;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export interface DeviceStorageConfiguration {
  deviceId: string;
  enabled: boolean;
  maxBytes: string | null;
  usedBytes: string;
  availableBytes: string;
  storageClass: DeviceStorageClass | null;
  availabilityStatus: DeviceStorageStatus;
  lastSeenAt: Date | null;
}

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(UserDevice)
    private readonly devices: Repository<UserDevice>,
    @InjectRepository(DevicePairingCode)
    private readonly pairingCodes: Repository<DevicePairingCode>,
    private readonly audit: AuditService,
    @InjectRepository(StorageTarget)
    private readonly storageTargets: Repository<StorageTarget>,
    @InjectRepository(DeviceStorageReplica)
    private readonly deviceStorageReplicas: Repository<DeviceStorageReplica>,
    @InjectRepository(DeviceFileAvailability)
    private readonly deviceAvailability: Repository<DeviceFileAvailability>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async createPairingCode(userId: string): Promise<{ code: string; expiresAt: Date }> {
    const now = new Date();
    await this.pairingCodes.delete({ expiresAt: LessThan(now) });

    const rawCode = randomBytes(16).toString('hex').toUpperCase();
    const expiresAt = new Date(now.getTime() + DEVICE_PAIRING_CODE_TTL_MS);
    const pairingCode = this.pairingCodes.create({
      userId,
      codeHash: this.hashPairingCode(rawCode),
      expiresAt,
      consumedAt: null,
    });
    const saved = await this.pairingCodes.save(pairingCode);
    await this.audit.record(userId, 'DEVICE_PAIRING_CODE_CREATED', 'DevicePairingCode', saved.id, { expiresAt });

    return {
      code: rawCode.match(/.{1,8}/g)!.join('-'),
      expiresAt,
    };
  }

  async consumePairingCode(code: string): Promise<string> {
    const normalized = code.replace(/-/g, '').toUpperCase();
    if (!/^[A-F\d]{32}$/.test(normalized)) {
      throw new UnauthorizedException('Device pairing code is invalid or expired');
    }

    const now = new Date();
    const result = await this.pairingCodes
      .createQueryBuilder()
      .update(DevicePairingCode)
      .set({ consumedAt: () => 'CURRENT_TIMESTAMP' })
      .where('"code_hash" = :codeHash AND "consumed_at" IS NULL AND "expires_at" > :now', {
        codeHash: this.hashPairingCode(normalized),
        now,
      })
      .returning('*')
      .execute();
    const consumed = result.raw?.[0] as { id?: string; user_id?: string } | undefined;
    if (!consumed?.id || !consumed.user_id) {
      throw new UnauthorizedException('Device pairing code is invalid or expired');
    }

    await this.audit.record(consumed.user_id, 'DEVICE_PAIRING_CODE_CONSUMED', 'DevicePairingCode', consumed.id);
    return consumed.user_id;
  }

  async registerForAuthentication(userId: string, dto: RegisterDeviceDto): Promise<UserDevice> {
    this.validatePeerIdentity(dto);
    let device = await this.devices.findOne({
      where: { userId, installationId: dto.installationId },
    });
    if (device?.revokedAt) throw new UnauthorizedException('This device has been revoked');

    if (device) {
      device.name = dto.name.trim();
      device.platform = dto.platform;
      device.clientVersion = dto.clientVersion?.trim() || null;
      if (dto.peerId && dto.peerPublicKey) {
        device.peerId = dto.peerId;
        device.peerPublicKey = dto.peerPublicKey;
      }
      device.lastSeenAt = new Date();
    } else {
      device = this.devices.create({
        userId,
        installationId: dto.installationId,
        name: dto.name.trim(),
        platform: dto.platform,
        clientVersion: dto.clientVersion?.trim() || null,
        peerId: dto.peerId ?? null,
        peerPublicKey: dto.peerPublicKey ?? null,
        refreshTokenHash: null,
        p2pEnabled: false,
        lanDiscoveryEnabled: true,
        internetP2pEnabled: false,
        relayAllowed: true,
        serveLocalFiles: false,
        storageContributionEnabled: false,
        lastSeenAt: new Date(),
        revokedAt: null,
      });
    }

    try {
      const saved = await this.devices.save(device);
      await this.audit.record(userId, 'DEVICE_REGISTERED', 'UserDevice', saved.id, { platform: saved.platform });
      return saved;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '23505') {
        throw new ConflictException('This device installation is already registered');
      }
      throw error;
    }
  }

  async list(userId: string): Promise<PublicDevice[]> {
    const devices = await this.devices.find({
      where: { userId },
      order: { lastSeenAt: 'DESC', createdAt: 'DESC' },
    });
    return devices.map((device) => this.toPublicDevice(device));
  }

  async listMeshPeers(userId: string) {
    const devices = await this.devices.find({
      where: [
        {
          userId,
          revokedAt: IsNull(),
          p2pEnabled: true,
          lanDiscoveryEnabled: true,
        },
        {
          userId,
          revokedAt: IsNull(),
          p2pEnabled: true,
          internetP2pEnabled: true,
        },
      ],
      order: { lastSeenAt: 'DESC' },
    });
    return devices
      .filter((device) => device.peerId && device.peerPublicKey)
      .map(({ id, name, platform, peerId, peerPublicKey, lastSeenAt }) => ({
        id,
        name,
        platform,
        peerId: peerId as string,
        peerPublicKey: peerPublicKey as string,
        lastSeenAt,
      }));
  }

  async getActive(userId: string, deviceId: string): Promise<UserDevice> {
    const device = await this.devices.findOne({
      where: { id: deviceId, userId },
    });
    if (!device || device.revokedAt) throw new UnauthorizedException('Device session is no longer valid');
    return device;
  }

  async getPublic(userId: string, deviceId: string): Promise<PublicDevice> {
    return this.toPublicDevice(await this.getActive(userId, deviceId));
  }

  async getRefreshTokenHash(userId: string, deviceId: string): Promise<string | null> {
    const device = await this.devices
      .createQueryBuilder('device')
      .addSelect('device.refreshTokenHash')
      .where('device.id = :deviceId AND device.userId = :userId AND device.revokedAt IS NULL', { deviceId, userId })
      .getOne();
    return device?.refreshTokenHash ?? null;
  }

  async updateRefreshTokenHash(userId: string, deviceId: string, hash: string | null): Promise<void> {
    const device = await this.getActive(userId, deviceId);
    device.refreshTokenHash = hash;
    device.lastSeenAt = new Date();
    await this.devices.save(device);
  }

  async touch(userId: string, deviceId: string): Promise<PublicDevice> {
    const device = await this.getActive(userId, deviceId);
    device.lastSeenAt = new Date();
    return this.toPublicDevice(await this.devices.save(device));
  }

  async updateSettings(userId: string, deviceId: string, dto: UpdateDeviceSettingsDto): Promise<PublicDevice> {
    const device = await this.getActive(userId, deviceId);
    Object.assign(device, dto);
    const saved = await this.devices.save(device);
    await this.audit.record(userId, 'DEVICE_SETTINGS_UPDATED', 'UserDevice', saved.id, dto as Record<string, unknown>);
    return this.toPublicDevice(saved);
  }

  async getStorageConfiguration(userId: string, deviceId: string): Promise<DeviceStorageConfiguration> {
    await this.getActive(userId, deviceId);
    const target = await this.storageTargets.findOne({ where: { deviceId } });
    const stale = !!target?.enabled && (!target.lastSeenAt || Date.now() - target.lastSeenAt.getTime() > DEVICE_STORAGE_HEARTBEAT_TTL_MS);
    if (target && stale && target.availabilityStatus !== DeviceStorageStatus.OFFLINE) {
      target.availabilityStatus = DeviceStorageStatus.OFFLINE;
      await this.storageTargets.save(target);
      await this.markDeviceStorageOffline(deviceId);
    }
    return this.toPublicStorageConfiguration(deviceId, target);
  }

  async configureStorage(userId: string, deviceId: string, dto: ConfigureDeviceStorageDto): Promise<DeviceStorageConfiguration> {
    const result = await this.dataSource.transaction(async (manager) => {
      const devices = manager.getRepository(UserDevice);
      const targets = manager.getRepository(StorageTarget);
      const device = await devices.findOne({
        where: { id: deviceId, userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!device || device.revokedAt) throw new UnauthorizedException('Device session is no longer valid');

      const current = await targets.findOne({
        where: { deviceId },
        lock: { mode: 'pessimistic_write' },
      });
      const enabled = dto.enabled ?? current?.enabled ?? false;
      const maxBytes = dto.maxBytes !== undefined ? this.parsePositiveBytes(dto.maxBytes) : current?.maxBytes ? BigInt(current.maxBytes) : null;
      const usedBytes = current ? BigInt(current.usedBytes) : 0n;
      if (maxBytes !== null && maxBytes < usedBytes) {
        throw new BadRequestException('Maximum capacity cannot be lower than the storage already in use');
      }
      if (enabled && maxBytes === null) {
        throw new BadRequestException('Set a positive maxBytes capacity before enabling device storage');
      }
      if (!current && !enabled && maxBytes === null) {
        device.storageContributionEnabled = false;
        await devices.save(device);
        return { target: null, device };
      }

      const wasEnabled = current?.enabled ?? false;
      const target =
        current ??
        targets.create({
          deviceId,
          cloudAccountId: null,
          type: 'DEVICE',
          name: device.name,
          remoteIdentifier: null,
          region: null,
          endpoint: null,
          prefix: '',
          forcePathStyle: false,
          usedBytes: '0',
          lastSeenAt: null,
        });
      target.name = device.name;
      target.enabled = enabled;
      target.maxBytes = maxBytes?.toString() ?? null;
      target.usedBytes = usedBytes.toString();
      target.availableBytes = (maxBytes === null ? 0n : maxBytes - usedBytes).toString();
      target.storageClass = dto.storageClass ?? current?.storageClass ?? DeviceStorageClass.VOLATILE;
      target.availabilityStatus = enabled ? (wasEnabled ? (current?.availabilityStatus ?? DeviceStorageStatus.OFFLINE) : DeviceStorageStatus.OFFLINE) : DeviceStorageStatus.DISABLED;
      if (!enabled || !wasEnabled) target.lastSeenAt = null;

      const savedTarget = await targets.save(target);
      device.storageContributionEnabled = enabled;
      await devices.save(device);
      return { target: savedTarget, device };
    });

    if (!result.device.storageContributionEnabled) {
      await this.markDeviceStorageOffline(deviceId);
    }
    await this.audit.record(userId, 'DEVICE_STORAGE_CONFIGURED', 'StorageTarget', result.target?.id ?? deviceId, {
      enabled: result.device.storageContributionEnabled,
      ...(dto.maxBytes !== undefined ? { maxBytes: dto.maxBytes } : {}),
      ...(dto.storageClass ? { storageClass: dto.storageClass } : {}),
    });
    return this.toPublicStorageConfiguration(deviceId, result.target);
  }

  async reportStorageHeartbeat(userId: string, deviceId: string, authenticatedDeviceId: string | undefined, dto: ReportDeviceStorageDto): Promise<DeviceStorageConfiguration> {
    if (authenticatedDeviceId !== deviceId) throw new ForbiddenException('A device can only report storage usage for its own session');
    const device = await this.getActive(userId, deviceId);
    if (!device.storageContributionEnabled) throw new ForbiddenException('Storage contribution is disabled for this device');
    const target = await this.storageTargets.findOne({
      where: { deviceId, enabled: true },
    });
    if (!target?.maxBytes) throw new NotFoundException('Device storage is not configured');

    const usedBytes = this.parseNonNegativeBytes(dto.usedBytes);
    const maxBytes = BigInt(target.maxBytes);
    if (usedBytes > maxBytes) throw new BadRequestException('Reported storage usage exceeds the configured device capacity');
    const now = new Date();
    target.usedBytes = usedBytes.toString();
    target.availableBytes = (maxBytes - usedBytes).toString();
    target.lastSeenAt = now;
    target.availabilityStatus = DeviceStorageStatus.ONLINE;
    await this.storageTargets.save(target);
    device.lastSeenAt = now;
    await this.devices.save(device);
    await this.deviceStorageReplicas.update(
      { deviceId, status: DeviceStorageReplicaStatus.OFFLINE },
      {
        status: DeviceStorageReplicaStatus.PENDING,
        leaseExpiresAt: null,
        lastError: 'Device reconnected; local replica must be verified before becoming available',
      },
    );
    return this.toPublicStorageConfiguration(deviceId, target);
  }

  async revoke(userId: string, deviceId: string): Promise<{ revoked: true }> {
    const device = await this.devices.findOne({
      where: { id: deviceId, userId },
    });
    if (!device) throw new NotFoundException('Device not found');
    if (device.revokedAt) return { revoked: true };

    device.revokedAt = new Date();
    device.refreshTokenHash = null;
    device.p2pEnabled = false;
    device.internetP2pEnabled = false;
    device.serveLocalFiles = false;
    device.storageContributionEnabled = false;
    await this.storageTargets.update(
      { deviceId },
      {
        enabled: false,
        availabilityStatus: DeviceStorageStatus.DISABLED,
        lastSeenAt: null,
      },
    );
    await this.markDeviceStorageOffline(deviceId);
    await this.devices.save(device);
    await this.audit.record(userId, 'DEVICE_REVOKED', 'UserDevice', device.id);
    return { revoked: true };
  }

  async isActive(userId: string, deviceId: string): Promise<boolean> {
    return !!(await this.devices.findOne({
      where: { id: deviceId, userId, revokedAt: IsNull() },
      select: { id: true },
    }));
  }

  private toPublicDevice(device: UserDevice): PublicDevice {
    const { installationId: _installationId, refreshTokenHash: _refreshTokenHash, peerPublicKey: _peerPublicKey, ...publicDevice } = device;
    return publicDevice;
  }

  private async markDeviceStorageOffline(deviceId: string): Promise<void> {
    await Promise.all([
      this.deviceStorageReplicas.update(
        { deviceId, status: DeviceStorageReplicaStatus.AVAILABLE },
        { status: DeviceStorageReplicaStatus.OFFLINE },
      ),
      this.deviceAvailability.update(
        { deviceId, status: DeviceFileAvailabilityStatus.AVAILABLE },
        { status: DeviceFileAvailabilityStatus.OFFLINE },
      ),
    ]);
  }

  private validatePeerIdentity(dto: RegisterDeviceDto): void {
    const hasPeerId = !!dto.peerId;
    const hasPeerPublicKey = !!dto.peerPublicKey;
    if (hasPeerId !== hasPeerPublicKey) {
      throw new BadRequestException('Peer ID and public key must be supplied together');
    }
    if (hasPeerId && !isMatchingEd25519PeerIdentity(dto.peerId!, dto.peerPublicKey!)) {
      throw new BadRequestException('Peer ID does not match the supplied Ed25519 public key');
    }
  }

  private hashPairingCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private toPublicStorageConfiguration(deviceId: string, target: StorageTarget | null): DeviceStorageConfiguration {
    if (!target) {
      return {
        deviceId,
        enabled: false,
        maxBytes: null,
        usedBytes: '0',
        availableBytes: '0',
        storageClass: null,
        availabilityStatus: DeviceStorageStatus.DISABLED,
        lastSeenAt: null,
      };
    }
    const lastSeenAt = target.lastSeenAt;
    const isFresh = !!lastSeenAt && Date.now() - lastSeenAt.getTime() <= DEVICE_STORAGE_HEARTBEAT_TTL_MS;
    return {
      deviceId,
      enabled: target.enabled,
      maxBytes: target.maxBytes,
      usedBytes: target.usedBytes,
      availableBytes: target.availableBytes,
      storageClass: target.storageClass,
      availabilityStatus: !target.enabled ? DeviceStorageStatus.DISABLED : isFresh ? DeviceStorageStatus.ONLINE : DeviceStorageStatus.OFFLINE,
      lastSeenAt,
    };
  }

  private parsePositiveBytes(value: string): bigint {
    const bytes = this.parseNonNegativeBytes(value);
    if (bytes === 0n) throw new BadRequestException('Capacity must be greater than zero');
    return bytes;
  }

  private parseNonNegativeBytes(value: string): bigint {
    if (!/^(0|[1-9]\d{0,18})$/.test(value)) throw new BadRequestException('Byte counts must be decimal integers within PostgreSQL bigint range');
    const bytes = BigInt(value);
    if (bytes > POSTGRES_BIGINT_MAX) throw new BadRequestException('Byte count exceeds PostgreSQL bigint range');
    return bytes;
  }
}
