import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { UpdateDeviceSettingsDto } from './dto/update-device-settings.dto';
import { UserDevice } from './entities/user-device.entity';

export type PublicDevice = Omit<UserDevice, 'installationId' | 'refreshTokenHash' | 'peerPublicKey'>;

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(UserDevice) private readonly devices: Repository<UserDevice>,
    private readonly audit: AuditService,
  ) {}

  async registerForAuthentication(userId: string, dto: RegisterDeviceDto): Promise<UserDevice> {
    let device = await this.devices.findOne({ where: { userId, installationId: dto.installationId } });
    if (device?.revokedAt) throw new UnauthorizedException('This device has been revoked');

    if (device) {
      device.name = dto.name.trim();
      device.platform = dto.platform;
      device.clientVersion = dto.clientVersion?.trim() || null;
      device.lastSeenAt = new Date();
    } else {
      device = this.devices.create({
        userId,
        installationId: dto.installationId,
        name: dto.name.trim(),
        platform: dto.platform,
        clientVersion: dto.clientVersion?.trim() || null,
        peerId: null,
        peerPublicKey: null,
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
    const devices = await this.devices.find({ where: { userId }, order: { lastSeenAt: 'DESC', createdAt: 'DESC' } });
    return devices.map((device) => this.toPublicDevice(device));
  }

  async getActive(userId: string, deviceId: string): Promise<UserDevice> {
    const device = await this.devices.findOne({ where: { id: deviceId, userId } });
    if (!device || device.revokedAt) throw new UnauthorizedException('Device session is no longer valid');
    return device;
  }

  async getPublic(userId: string, deviceId: string): Promise<PublicDevice> {
    return this.toPublicDevice(await this.getActive(userId, deviceId));
  }

  async getRefreshTokenHash(userId: string, deviceId: string): Promise<string | null> {
    const device = await this.devices.createQueryBuilder('device')
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

  async revoke(userId: string, deviceId: string): Promise<{ revoked: true }> {
    const device = await this.devices.findOne({ where: { id: deviceId, userId } });
    if (!device) throw new NotFoundException('Device not found');
    if (device.revokedAt) return { revoked: true };

    device.revokedAt = new Date();
    device.refreshTokenHash = null;
    device.p2pEnabled = false;
    device.internetP2pEnabled = false;
    device.serveLocalFiles = false;
    device.storageContributionEnabled = false;
    await this.devices.save(device);
    await this.audit.record(userId, 'DEVICE_REVOKED', 'UserDevice', device.id);
    return { revoked: true };
  }

  async isActive(userId: string, deviceId: string): Promise<boolean> {
    return !!await this.devices.findOne({ where: { id: deviceId, userId, revokedAt: IsNull() }, select: { id: true } });
  }

  private toPublicDevice(device: UserDevice): PublicDevice {
    const { installationId: _installationId, refreshTokenHash: _refreshTokenHash, peerPublicKey: _peerPublicKey, ...publicDevice } = device;
    return publicDevice;
  }
}
