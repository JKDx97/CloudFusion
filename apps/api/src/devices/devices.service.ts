import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { IsNull, LessThan, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { UpdateDeviceSettingsDto } from './dto/update-device-settings.dto';
import { DevicePairingCode } from './entities/device-pairing-code.entity';
import { UserDevice } from './entities/user-device.entity';
import { isMatchingEd25519PeerIdentity } from './peer-identity';

export type PublicDevice = Omit<UserDevice, 'installationId' | 'refreshTokenHash' | 'peerPublicKey'>;
const DEVICE_PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(UserDevice) private readonly devices: Repository<UserDevice>,
    @InjectRepository(DevicePairingCode) private readonly pairingCodes: Repository<DevicePairingCode>,
    private readonly audit: AuditService,
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
    const result = await this.pairingCodes.createQueryBuilder()
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
    let device = await this.devices.findOne({ where: { userId, installationId: dto.installationId } });
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
    const devices = await this.devices.find({ where: { userId }, order: { lastSeenAt: 'DESC', createdAt: 'DESC' } });
    return devices.map((device) => this.toPublicDevice(device));
  }

  async listMeshPeers(userId: string) {
    const devices = await this.devices.find({
      where: [
        { userId, revokedAt: IsNull(), p2pEnabled: true, lanDiscoveryEnabled: true },
        { userId, revokedAt: IsNull(), p2pEnabled: true, internetP2pEnabled: true },
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
}
