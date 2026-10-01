import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { DevicesService } from '../devices/devices.service';
import { UserDevice } from '../devices/entities/user-device.entity';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { VirtualNodeStatus } from '../virtual-fs/enums/virtual-node-status.enum';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';
import { PermissionsService } from '../permissions/permissions.service';
import { AdvertiseAvailabilityDto } from './dto/advertise-availability.dto';
import { AuthorizePeerTransferDto } from './dto/authorize-peer-transfer.dto';
import { DeviceFileAvailability, DeviceFileAvailabilityStatus } from './entities/device-file-availability.entity';
import { DeviceStorageReplica, DeviceStorageReplicaStatus } from './entities/device-storage-replica.entity';
import { StorageTarget } from '../providers/object-storage/entities/storage-target.entity';
import { PeerTransferSession } from './entities/peer-transfer-session.entity';
import { PeerTransferStatus, PeerTransferTransport } from './enums/peer-transfer-status.enum';

const TICKET_ISSUER = 'cloudfusion-api';
const TICKET_AUDIENCE = 'cloudfusion-peer-transfer';
const ACTIVE_TRANSFER_STATUSES = [
  PeerTransferStatus.AUTHORIZED,
  PeerTransferStatus.CLAIMED,
  PeerTransferStatus.TRANSFERRING,
  PeerTransferStatus.VERIFYING,
];
const AVAILABILITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_STORAGE_HEARTBEAT_TTL_MS = 3 * 60 * 1000;

interface PeerTransferTicketClaims {
  sub: string;
  type: 'peer-transfer';
  transferId: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  nodeId: string;
  versionId: string;
  contentHash: string;
  totalBytes: string;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

@Injectable()
export class P2pService {
  constructor(
    @InjectRepository(UserDevice) private readonly devices: Repository<UserDevice>,
    @InjectRepository(VirtualNode) private readonly nodes: Repository<VirtualNode>,
    @InjectRepository(FileVersion) private readonly versions: Repository<FileVersion>,
    @InjectRepository(DeviceFileAvailability) private readonly availability: Repository<DeviceFileAvailability>,
    @InjectRepository(DeviceStorageReplica) private readonly deviceStorageReplicas: Repository<DeviceStorageReplica>,
    @InjectRepository(StorageTarget) private readonly storageTargets: Repository<StorageTarget>,
    @InjectRepository(PeerTransferSession) private readonly transfers: Repository<PeerTransferSession>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly deviceSessions: DevicesService,
    private readonly permissions: PermissionsService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async advertiseAvailability(userId: string, deviceId: string | undefined, dto: AdvertiseAvailabilityDto) {
    const device = await this.requireCurrentDevice(userId, deviceId);
    this.requireServingDevice(device);
    return this.advertiseForDevice(userId, device, dto, true);
  }

  async advertiseAvailabilityBatch(userId: string, deviceId: string | undefined, items: AdvertiseAvailabilityDto[]) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 500) {
      throw new BadRequestException('A P2P availability batch must contain between 1 and 500 items');
    }
    const device = await this.requireCurrentDevice(userId, deviceId);
    this.requireServingDevice(device);
    const results: Array<{ nodeId: string; versionId: string; advertised: boolean }> = [];
    for (let offset = 0; offset < items.length; offset += 10) {
      const chunk = items.slice(offset, offset + 10);
      const outcomes = await Promise.all(chunk.map(async (item) => {
        try {
          await this.advertiseForDevice(userId, device, item, false);
          return { nodeId: item.nodeId, versionId: item.versionId, advertised: true };
        } catch {
          return { nodeId: item.nodeId, versionId: item.versionId, advertised: false };
        }
      }));
      results.push(...outcomes);
    }
    const accepted = results.filter((result) => result.advertised).length;
    await this.audit.record(userId, 'P2P_FILE_AVAILABILITY_BATCH_ADVERTISED', 'UserDevice', device.id, {
      accepted,
      rejected: results.length - accepted,
    });
    return { results };
  }

  private async advertiseForDevice(
    userId: string,
    device: UserDevice,
    dto: AdvertiseAvailabilityDto,
    recordAudit: boolean,
  ) {
    const { node, version } = await this.requireReadableVersion(userId, dto.nodeId, dto.versionId);
    if (dto.contentHash.toLowerCase() !== version.checksum.toLowerCase() || BigInt(dto.sizeBytes) !== BigInt(version.size)) {
      throw new ConflictException('The local file does not match the authorized CloudFusion version');
    }
    const now = new Date();
    const record = await this.availability.findOne({ where: { deviceId: device.id, nodeId: node.id, versionId: version.id } });
    const value = record ?? this.availability.create({
      userId,
      deviceId: device.id,
      nodeId: node.id,
      versionId: version.id,
      contentHash: version.checksum,
      sizeBytes: version.size,
      status: DeviceFileAvailabilityStatus.AVAILABLE,
      lastVerifiedAt: now,
      expiresAt: this.addSeconds(now, this.availabilityTtlSeconds()),
    });
    value.userId = userId;
    value.deviceId = device.id;
    value.nodeId = node.id;
    value.versionId = version.id;
    value.contentHash = version.checksum;
    value.sizeBytes = version.size;
    value.status = DeviceFileAvailabilityStatus.AVAILABLE;
    value.lastVerifiedAt = now;
    value.expiresAt = this.addSeconds(now, this.availabilityTtlSeconds());
    await this.availability.save(value);
    if (recordAudit) {
      await this.audit.record(userId, 'P2P_FILE_AVAILABILITY_ADVERTISED', 'VirtualNode', node.id, {
        deviceId: device.id,
        versionId: version.id,
      });
    }
    return {
      nodeId: node.id,
      versionId: version.id,
      lastVerifiedAt: value.lastVerifiedAt,
      expiresAt: value.expiresAt,
    };
  }

  async withdrawAvailability(userId: string, deviceId: string | undefined, nodeId: string, versionId: string) {
    const device = await this.requireCurrentDevice(userId, deviceId);
    await this.availability.delete({ userId, deviceId: device.id, nodeId, versionId });
    return { withdrawn: true };
  }

  async listAvailability(userId: string, nodeId: string, versionId: string) {
    const { node, version } = await this.requireReadableVersion(userId, nodeId, versionId);
    const now = new Date();
    await this.availability.update(
      { nodeId, versionId, status: DeviceFileAvailabilityStatus.AVAILABLE, expiresAt: LessThan(now) },
      { status: DeviceFileAvailabilityStatus.OFFLINE },
    );
    await this.availability.delete({
      nodeId,
      versionId,
      status: In([DeviceFileAvailabilityStatus.OFFLINE, DeviceFileAvailabilityStatus.CORRUPTED]),
      expiresAt: LessThan(new Date(now.getTime() - AVAILABILITY_RETENTION_MS)),
    });
    const rows = await this.availability.find({
      where: {
        nodeId,
        versionId,
        expiresAt: MoreThan(now),
        contentHash: version.checksum,
        sizeBytes: version.size,
        status: DeviceFileAvailabilityStatus.AVAILABLE,
      },
        order: { lastVerifiedAt: 'DESC' },
      take: 256,
    });
    const peers = [];
    for (const row of rows) {
      const device = await this.devices.findOne({ where: { id: row.deviceId, revokedAt: IsNull() } });
      if (!device || row.userId !== device.userId || !device.peerId || !device.p2pEnabled || !device.serveLocalFiles) continue;
      if (await this.hasStaleStorageHeartbeat(device)) {
        await this.markDeviceOffline(device.id);
        continue;
      }
      if (!(await this.permissions.canDownload(device.userId, node.id))) continue;
      peers.push({
        deviceId: device.id,
        name: device.name,
        platform: device.platform,
        peerId: device.peerId,
        lastVerifiedAt: row.lastVerifiedAt,
        expiresAt: row.expiresAt,
        advertisedSize: row.sizeBytes,
      });
    }
    return peers;
  }

  async authorizeTransfer(userId: string, deviceId: string | undefined, dto: AuthorizePeerTransferDto) {
    const destination = await this.requireCurrentDevice(userId, deviceId);
    this.requirePeerEnabled(destination);
    const source = await this.devices.findOne({ where: { id: dto.sourceDeviceId, revokedAt: IsNull() } });
    if (!source) throw new NotFoundException('Source device is unavailable');
    if (source.id === destination.id) throw new ConflictException('Source and destination devices must be different');
    this.requireServingDevice(source);

    const { node, version } = await this.requireReadableVersion(userId, dto.nodeId, dto.versionId);
    if (!(await this.permissions.canDownload(source.userId, node.id))) {
      throw new NotFoundException('Source device is not authorized for this file');
    }
    await this.requireFreshAvailability(source, node.id, version);

    const ttlSeconds = this.ticketTtlSeconds();
    const now = new Date();
    const transfer = await this.dataSource.transaction(async (manager) => {
      const peerDeviceIds = [source.id, destination.id].sort();
      for (const peerDeviceId of peerDeviceIds) {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`p2p-device:${peerDeviceId}`]);
      }
      const repository = manager.getRepository(PeerTransferSession);
      await repository.createQueryBuilder()
        .update(PeerTransferSession)
        .set({ status: PeerTransferStatus.EXPIRED })
        .where(
          'status = :authorized AND ticket_expires_at <= :now AND (source_device_id IN (:...peerDeviceIds) OR destination_device_id IN (:...peerDeviceIds))',
          { authorized: PeerTransferStatus.AUTHORIZED, now, peerDeviceIds },
        )
        .execute();
      const activeStatuses = In(ACTIVE_TRANSFER_STATUSES);
      const maxConcurrent = this.boundedConfigInteger('p2p.maxConcurrentTransfers', 4, 1, 16);
      for (const peerDeviceId of peerDeviceIds) {
        const activeCount = await repository.count({
          where: [
            { sourceDeviceId: peerDeviceId, status: activeStatuses },
            { destinationDeviceId: peerDeviceId, status: activeStatuses },
          ],
        });
        if (activeCount >= maxConcurrent) {
          throw new HttpException('This device has reached its active peer-transfer limit', HttpStatus.TOO_MANY_REQUESTS);
        }
      }
      return repository.save(repository.create({
        sourceUserId: source.userId,
        destinationUserId: destination.userId,
        sourceDeviceId: source.id,
        destinationDeviceId: destination.id,
        nodeId: node.id,
        versionId: version.id,
        contentHash: version.checksum,
        totalBytes: version.size,
        status: PeerTransferStatus.AUTHORIZED,
        transport: null,
        bytesTransferred: '0',
        ticketExpiresAt: this.addSeconds(now, ttlSeconds),
        startedAt: null,
        completedAt: null,
      }));
    });

    const secret = this.accessTokenSecret();
    const ticket = await this.jwt.signAsync(
      {
        sub: source.userId,
        type: 'peer-transfer',
        transferId: transfer.id,
        sourceDeviceId: source.id,
        destinationDeviceId: destination.id,
        nodeId: node.id,
        versionId: version.id,
        contentHash: version.checksum,
        totalBytes: version.size,
      },
      {
        secret,
        algorithm: 'HS256',
        issuer: TICKET_ISSUER,
        audience: TICKET_AUDIENCE,
        expiresIn: ttlSeconds,
        jwtid: transfer.id,
      },
    );

    await this.audit.record(userId, 'P2P_TRANSFER_AUTHORIZED', 'PeerTransferSession', transfer.id, {
      sourceDeviceId: source.id,
      destinationDeviceId: destination.id,
      nodeId: node.id,
      versionId: version.id,
    });
    return { transfer: this.toPublicTransfer(transfer), ticket };
  }

  async claimTransfer(userId: string, deviceId: string | undefined, transferId: string, ticket: string) {
    const actor = await this.requireCurrentDevice(userId, deviceId);
    let claims: PeerTransferTicketClaims;
    try {
      claims = await this.jwt.verifyAsync<PeerTransferTicketClaims>(ticket, {
        secret: this.accessTokenSecret(),
        algorithms: ['HS256'],
        issuer: TICKET_ISSUER,
        audience: TICKET_AUDIENCE,
        clockTolerance: 5,
      });
    } catch {
      throw new UnauthorizedException('Peer transfer ticket is invalid or expired');
    }
    if (
      claims.type !== 'peer-transfer' ||
      claims.jti !== claims.transferId ||
      claims.transferId !== transferId ||
      claims.sourceDeviceId !== actor.id ||
      claims.sub !== userId
    ) {
      throw new ForbiddenException('Ticket is not issued to this source device');
    }

    const transfer = await this.transfers.findOne({ where: { id: claims.transferId } });
    if (!transfer || transfer.status !== PeerTransferStatus.AUTHORIZED) {
      throw new ConflictException('Peer transfer ticket has already been used or revoked');
    }
    if (transfer.ticketExpiresAt <= new Date() || claims.exp * 1000 <= Date.now()) {
      transfer.status = PeerTransferStatus.EXPIRED;
      await this.transfers.save(transfer);
      throw new UnauthorizedException('Peer transfer ticket has expired');
    }
    if (
      claims.sourceDeviceId !== transfer.sourceDeviceId ||
      claims.destinationDeviceId !== transfer.destinationDeviceId ||
      claims.nodeId !== transfer.nodeId ||
      claims.versionId !== transfer.versionId ||
      claims.contentHash !== transfer.contentHash ||
      claims.totalBytes !== transfer.totalBytes
    ) throw new UnauthorizedException('Peer transfer ticket does not match its authorization');

    const source = await this.deviceSessions.getActive(transfer.sourceUserId, transfer.sourceDeviceId);
    const destination = await this.deviceSessions.getActive(transfer.destinationUserId, transfer.destinationDeviceId);
    this.requireServingDevice(source);
    this.requirePeerEnabled(destination);
    const { node, version } = await this.requireReadableVersion(transfer.destinationUserId, transfer.nodeId, transfer.versionId);
    if (!(await this.permissions.canDownload(source.userId, node.id))) {
      throw new ForbiddenException('Source permission has been revoked');
    }
    await this.requireFreshAvailability(source, node.id, version);

    const now = new Date();
    const updated = await this.transfers.createQueryBuilder()
      .update(PeerTransferSession)
      .set({ status: PeerTransferStatus.CLAIMED, startedAt: now })
      .where('id = :id AND status = :status AND ticket_expires_at > :now', {
        id: transfer.id,
        status: PeerTransferStatus.AUTHORIZED,
        now,
      })
      .execute();
    if (updated.affected !== 1) throw new ConflictException('Peer transfer ticket has already been claimed');
    transfer.status = PeerTransferStatus.CLAIMED;
    transfer.startedAt = now;
    await this.audit.record(userId, 'P2P_TRANSFER_CLAIMED', 'PeerTransferSession', transfer.id, {
      sourceDeviceId: source.id,
      destinationDeviceId: destination.id,
    });

    return {
      transfer: this.toPublicTransfer(transfer),
      sourcePeerId: source.peerId,
      destinationPeerId: destination.peerId,
      contentHash: version.checksum,
      totalBytes: version.size,
    };
  }

  async updateTransferState(
    userId: string,
    deviceId: string | undefined,
    transferId: string,
    nextStatus: PeerTransferStatus,
    transport?: PeerTransferTransport,
    bytesTransferred?: string,
  ) {
    const transfer = await this.requireParticipant(userId, deviceId, transferId);
    const isProgressUpdate = transfer.status === PeerTransferStatus.TRANSFERRING && nextStatus === PeerTransferStatus.TRANSFERRING;
    if (!isProgressUpdate && !this.canTransition(transfer.status, nextStatus)) {
      throw new ConflictException('Invalid peer transfer state transition');
    }
    if (
      (nextStatus === PeerTransferStatus.VERIFYING || nextStatus === PeerTransferStatus.COMPLETED) &&
      deviceId !== transfer.destinationDeviceId
    ) throw new ForbiddenException('Only the receiving device may verify transfer completion');
    if (bytesTransferred !== undefined) {
      if (deviceId !== transfer.destinationDeviceId) {
        throw new ForbiddenException('Only the receiving device may report verified transfer progress');
      }
      const bytes = BigInt(bytesTransferred);
      if (bytes < BigInt(transfer.bytesTransferred) || bytes > BigInt(transfer.totalBytes)) {
        throw new ConflictException('Transferred byte count must be monotonic and within the authorized size');
      }
      transfer.bytesTransferred = bytes.toString();
    }
    if (transport) transfer.transport = transport;
    transfer.status = nextStatus;
    if (nextStatus === PeerTransferStatus.COMPLETED || nextStatus === PeerTransferStatus.FAILED || nextStatus === PeerTransferStatus.CANCELLED) {
      transfer.completedAt = new Date();
    }
    if (nextStatus === PeerTransferStatus.COMPLETED && BigInt(transfer.bytesTransferred) !== BigInt(transfer.totalBytes)) {
      throw new ConflictException('A transfer cannot complete before every authorized byte is verified');
    }
    await this.transfers.save(transfer);
    if ([PeerTransferStatus.COMPLETED, PeerTransferStatus.FAILED, PeerTransferStatus.CANCELLED].includes(nextStatus)) {
      await this.audit.record(userId, `P2P_TRANSFER_${nextStatus}`, 'PeerTransferSession', transfer.id, {
        transport: transfer.transport,
        bytesTransferred: transfer.bytesTransferred,
      });
    }
    return this.toPublicTransfer(transfer);
  }

  async getTransfer(userId: string, deviceId: string | undefined, transferId: string) {
    const transfer = await this.requireParticipant(userId, deviceId, transferId);
    if (ACTIVE_TRANSFER_STATUSES.includes(transfer.status)) {
      const [source, destination] = await Promise.all([
        this.deviceSessions.getActive(transfer.sourceUserId, transfer.sourceDeviceId),
        this.deviceSessions.getActive(transfer.destinationUserId, transfer.destinationDeviceId),
      ]);
      this.requireServingDevice(source);
      this.requirePeerEnabled(destination);
    }
    if (transfer.status === PeerTransferStatus.AUTHORIZED && transfer.ticketExpiresAt <= new Date()) {
      transfer.status = PeerTransferStatus.EXPIRED;
      await this.transfers.save(transfer);
    }
    return this.toPublicTransfer(transfer);
  }

  async cancelTransfer(userId: string, deviceId: string | undefined, transferId: string) {
    const transfer = await this.requireParticipant(userId, deviceId, transferId);
    if (!ACTIVE_TRANSFER_STATUSES.includes(transfer.status)) throw new ConflictException('This peer transfer can no longer be cancelled');
    transfer.status = PeerTransferStatus.CANCELLED;
    transfer.completedAt = new Date();
    await this.transfers.save(transfer);
    await this.audit.record(userId, 'P2P_TRANSFER_CANCELLED', 'PeerTransferSession', transfer.id);
    return this.toPublicTransfer(transfer);
  }

  private async requireReadableVersion(userId: string, nodeId: string, versionId: string) {
    const node = await this.nodes.findOne({ where: { id: nodeId, deletedAt: IsNull() } });
    if (!node || node.type !== VirtualNodeType.FILE) throw new NotFoundException('File version not found');
    if (node.status !== VirtualNodeStatus.AVAILABLE) throw new ConflictException('File is not available for peer transfer');
    if (!(await this.permissions.canDownload(userId, node.id))) throw new NotFoundException('File version not found');
    const version = await this.versions.findOne({ where: { id: versionId, virtualNodeId: node.id } });
    if (!version || !/^[a-f\d]{64}$/i.test(version.checksum) || !/^\d+$/.test(version.size)) {
      throw new NotFoundException('File version not found');
    }
    return { node, version };
  }

  private async requireFreshAvailability(device: UserDevice, nodeId: string, version: FileVersion) {
    if (await this.hasStaleStorageHeartbeat(device)) {
      await this.markDeviceOffline(device.id);
      throw new NotFoundException('This device is offline and is not advertising the requested file version');
    }
    const record = await this.availability.findOne({
      where: {
        deviceId: device.id,
        nodeId,
        versionId: version.id,
        contentHash: version.checksum,
        sizeBytes: version.size,
        expiresAt: MoreThan(new Date()),
        status: DeviceFileAvailabilityStatus.AVAILABLE,
      },
    });
    if (!record) throw new NotFoundException('This device is not advertising the requested file version');
    return record;
  }

  private async hasStaleStorageHeartbeat(device: UserDevice): Promise<boolean> {
    if (!device.storageContributionEnabled) return false;
    const target = await this.storageTargets.findOne({ where: { deviceId: device.id, enabled: true } });
    return !target?.lastSeenAt || Date.now() - target.lastSeenAt.getTime() > DEVICE_STORAGE_HEARTBEAT_TTL_MS;
  }

  private async markDeviceOffline(deviceId: string): Promise<void> {
    await Promise.all([
      this.availability.update(
        { deviceId, status: DeviceFileAvailabilityStatus.AVAILABLE },
        { status: DeviceFileAvailabilityStatus.OFFLINE },
      ),
      this.deviceStorageReplicas.update(
        { deviceId, status: DeviceStorageReplicaStatus.AVAILABLE },
        { status: DeviceStorageReplicaStatus.OFFLINE },
      ),
    ]);
  }

  private async requireCurrentDevice(userId: string, deviceId?: string) {
    if (!deviceId) throw new UnauthorizedException('A registered device session is required for P2P');
    return this.deviceSessions.getActive(userId, deviceId);
  }

  private requirePeerEnabled(device: UserDevice) {
    if (device.revokedAt || !device.peerId || !device.p2pEnabled) {
      throw new ForbiddenException('P2P is not enabled for this device');
    }
  }

  private requireServingDevice(device: UserDevice) {
    this.requirePeerEnabled(device);
    if (!device.serveLocalFiles) throw new ForbiddenException('This device has not allowed serving local files');
  }

  private async requireParticipant(userId: string, deviceId: string | undefined, transferId: string) {
    if (!deviceId) throw new UnauthorizedException('A registered device session is required');
    const transfer = await this.transfers.findOne({ where: { id: transferId } });
    if (!transfer) throw new NotFoundException('Peer transfer not found');
    const isSource = transfer.sourceUserId === userId && transfer.sourceDeviceId === deviceId;
    const isDestination = transfer.destinationUserId === userId && transfer.destinationDeviceId === deviceId;
    if (!isSource && !isDestination) throw new NotFoundException('Peer transfer not found');
    await this.deviceSessions.getActive(userId, deviceId);
    return transfer;
  }

  private canTransition(current: PeerTransferStatus, next: PeerTransferStatus): boolean {
    const transitions: Record<PeerTransferStatus, PeerTransferStatus[]> = {
      [PeerTransferStatus.AUTHORIZED]: [PeerTransferStatus.CLAIMED, PeerTransferStatus.CANCELLED, PeerTransferStatus.EXPIRED],
      [PeerTransferStatus.CLAIMED]: [PeerTransferStatus.TRANSFERRING, PeerTransferStatus.FAILED, PeerTransferStatus.CANCELLED],
      [PeerTransferStatus.TRANSFERRING]: [PeerTransferStatus.VERIFYING, PeerTransferStatus.FAILED, PeerTransferStatus.CANCELLED],
      [PeerTransferStatus.VERIFYING]: [PeerTransferStatus.COMPLETED, PeerTransferStatus.FAILED, PeerTransferStatus.CANCELLED],
      [PeerTransferStatus.COMPLETED]: [],
      [PeerTransferStatus.FAILED]: [],
      [PeerTransferStatus.CANCELLED]: [],
      [PeerTransferStatus.EXPIRED]: [],
    };
    return transitions[current].includes(next);
  }

  private ticketTtlSeconds(): number {
    return this.boundedConfigInteger('p2p.transferTicketTtlSeconds', 120, 30, 300);
  }

  private availabilityTtlSeconds(): number {
    return this.boundedConfigInteger('p2p.availabilityTtlSeconds', 900, 60, 3600);
  }

  private boundedConfigInteger(key: string, fallback: number, min: number, max: number): number {
    const parsed = Number(this.config.get<number | string>(key));
    return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  }

  private accessTokenSecret(): string {
    const secret = this.config.get<string>('jwt.accessSecret');
    if (!secret) throw new Error('JWT access signing key is not configured');
    return secret;
  }

  private addSeconds(date: Date, seconds: number): Date {
    return new Date(date.getTime() + seconds * 1000);
  }

  private toPublicTransfer(transfer: PeerTransferSession) {
    return {
      id: transfer.id,
      sourceDeviceId: transfer.sourceDeviceId,
      destinationDeviceId: transfer.destinationDeviceId,
      nodeId: transfer.nodeId,
      versionId: transfer.versionId,
      contentHash: transfer.contentHash,
      totalBytes: transfer.totalBytes,
      bytesTransferred: transfer.bytesTransferred,
      status: transfer.status,
      transport: transfer.transport,
      ticketExpiresAt: transfer.ticketExpiresAt,
      startedAt: transfer.startedAt,
      completedAt: transfer.completedAt,
      createdAt: transfer.createdAt,
    };
  }
}
