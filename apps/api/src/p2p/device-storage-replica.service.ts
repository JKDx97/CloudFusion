import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { DevicesService } from '../devices/devices.service';
import { StorageTarget } from '../providers/object-storage/entities/storage-target.entity';
import { DeviceStorageStatus } from '../providers/object-storage/enums/device-storage-status.enum';
import { PermissionsService } from '../permissions/permissions.service';
import { DeviceStorageReplica, DeviceStorageReplicaStatus } from './entities/device-storage-replica.entity';
import { DeviceFileAvailability, DeviceFileAvailabilityStatus } from './entities/device-file-availability.entity';
import { UserDevice } from '../devices/entities/user-device.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { StorageObject } from '../virtual-fs/entities/storage-object.entity';
import { StorageReplica } from '../virtual-fs/entities/storage-replica.entity';
import { StorageReplicaStatus } from '../virtual-fs/enums/storage-replica-status.enum';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';
import { CompleteDeviceStorageReplicaDto } from './dto/complete-device-storage-replica.dto';
import { User } from '../users/entities/user.entity';

const DEVICE_STORAGE_HEARTBEAT_TTL_MS = 3 * 60 * 1000;
const DEVICE_REPLICA_LEASE_MS = 20 * 60 * 1000;
const AVAILABILITY_LEASE_MS = 15 * 60 * 1000;
const CANDIDATE_BATCH_SIZE = 250;

interface ReplicaCandidate {
  nodeId: string;
  versionId: string;
  storageObjectId: string;
  contentHash: string;
  sizeBytes: string;
}

export interface DeviceStorageReplicaWorkItem {
  assignmentId: string;
  nodeId: string;
  versionId: string;
  contentHash: string;
  sizeBytes: string;
  attempts: number;
}

@Injectable()
export class DeviceStorageReplicaService {
  constructor(
    @InjectRepository(DeviceStorageReplica) private readonly assignments: Repository<DeviceStorageReplica>,
    @InjectRepository(VirtualNode) private readonly nodes: Repository<VirtualNode>,
    @InjectRepository(FileVersion) private readonly versions: Repository<FileVersion>,
    @InjectRepository(StorageReplica) private readonly cloudReplicas: Repository<StorageReplica>,
    @InjectRepository(DeviceFileAvailability) private readonly availability: Repository<DeviceFileAvailability>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly deviceSessions: DevicesService,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async next(userId: string, deviceId?: string): Promise<{ assignment: DeviceStorageReplicaWorkItem | null }> {
    const device = await this.requireContributingDevice(userId, deviceId);
    let storageOnline = false;
    const assignment = await this.dataSource.transaction(async (manager) => {
      const targets = manager.getRepository(StorageTarget);
      const target = await targets.findOne({
        where: { deviceId: device.id, type: 'DEVICE', enabled: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!target?.maxBytes) throw new NotFoundException('Device storage capacity is not configured');
      if (!target.lastSeenAt || Date.now() - target.lastSeenAt.getTime() > DEVICE_STORAGE_HEARTBEAT_TTL_MS) {
        target.availabilityStatus = DeviceStorageStatus.OFFLINE;
        await targets.save(target);
        return null;
      }
      if (target.availabilityStatus !== DeviceStorageStatus.ONLINE) return null;
      storageOnline = true;

      const assignments = manager.getRepository(DeviceStorageReplica);
      const now = new Date();
      await assignments.createQueryBuilder()
        .update(DeviceStorageReplica)
        .set({ status: DeviceStorageReplicaStatus.PENDING, leaseExpiresAt: null, lastError: 'Download lease expired; retry scheduled' })
        .where('"device_id" = :deviceId AND "status" = :downloading AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= :now)', {
          deviceId: device.id,
          downloading: DeviceStorageReplicaStatus.DOWNLOADING,
          now,
        })
        .execute();

      const current = await assignments.findOne({
        where: {
          deviceId: device.id,
          status: DeviceStorageReplicaStatus.DOWNLOADING,
        },
        order: { createdAt: 'ASC' },
      });
      if (current) {
        current.leaseExpiresAt = this.addMilliseconds(now, DEVICE_REPLICA_LEASE_MS);
        await assignments.save(current);
        return current;
      }

      const maxBytes = BigInt(target.maxBytes);
      const [availableBytes, reservedBytes] = await Promise.all([
        this.sumAssignments(assignments, device.id, [DeviceStorageReplicaStatus.AVAILABLE]),
        this.sumAssignments(assignments, device.id, [DeviceStorageReplicaStatus.PENDING, DeviceStorageReplicaStatus.DOWNLOADING]),
      ]);
      const alreadyUsed = BigInt(target.usedBytes) > availableBytes ? BigInt(target.usedBytes) : availableBytes;
      if (alreadyUsed + reservedBytes > maxBytes) return null;

      const pending = await assignments.findOne({
        where: { deviceId: device.id, status: DeviceStorageReplicaStatus.PENDING },
        order: { createdAt: 'ASC' },
      });
      if (pending) {
        pending.status = DeviceStorageReplicaStatus.DOWNLOADING;
        pending.attempts += 1;
        pending.leaseExpiresAt = this.addMilliseconds(now, DEVICE_REPLICA_LEASE_MS);
        pending.lastError = null;
        return assignments.save(pending);
      }

      const freeBytes = maxBytes > alreadyUsed + reservedBytes ? maxBytes - alreadyUsed - reservedBytes : 0n;
      if (freeBytes <= 0n) return null;

      const candidates = await this.nodes.createQueryBuilder('node')
        .innerJoin(FileVersion, 'version', 'version.id = node.current_version_id AND version.virtual_node_id = node.id')
        .innerJoin(StorageObject, 'object', 'object.id = version.storage_object_id AND object.user_id = node.user_id')
        .innerJoin(StorageReplica, 'cloudReplica', 'cloudReplica.storage_object_id = object.id AND cloudReplica.status = :healthy AND cloudReplica.remote_file_id IS NOT NULL')
        .select('node.id', 'nodeId')
        .addSelect('version.id', 'versionId')
        .addSelect('object.id', 'storageObjectId')
        .addSelect('version.checksum', 'contentHash')
        .addSelect('version.size', 'sizeBytes')
        .where('node.user_id = :userId', { userId })
        .andWhere('node.workspace_id IS NULL')
        .andWhere('node.deleted_at IS NULL')
        .andWhere('node.type = :fileType', { fileType: VirtualNodeType.FILE })
        .andWhere('node.current_version_id IS NOT NULL')
        .andWhere("object.lifecycle_status = 'ACTIVE'")
        .andWhere('object.status IN (:...objectStatuses)', { objectStatuses: ['AVAILABLE', 'DEGRADED'] })
        .setParameter('healthy', StorageReplicaStatus.HEALTHY)
        .distinct(true)
        .orderBy('node.created_at', 'ASC')
        .addOrderBy('node.id', 'ASC')
        .take(CANDIDATE_BATCH_SIZE)
        .getRawMany<ReplicaCandidate>();

      for (const candidate of candidates) {
        if (!/^[a-f\d]{64}$/i.test(candidate.contentHash) || !/^\d+$/.test(candidate.sizeBytes)) continue;
        if (BigInt(candidate.sizeBytes) > freeBytes) continue;
        const previous = await assignments.findOne({
          where: { deviceId: device.id, nodeId: candidate.nodeId, versionId: candidate.versionId },
        });
        if (previous) continue;
        if (!(await this.permissions.canDownload(userId, candidate.nodeId))) continue;
        return assignments.save(assignments.create({
          userId,
          deviceId: device.id,
          nodeId: candidate.nodeId,
          versionId: candidate.versionId,
          storageObjectId: candidate.storageObjectId,
          contentHash: candidate.contentHash,
          sizeBytes: candidate.sizeBytes,
          status: DeviceStorageReplicaStatus.DOWNLOADING,
          attempts: 1,
          leaseExpiresAt: this.addMilliseconds(now, DEVICE_REPLICA_LEASE_MS),
          lastVerifiedAt: null,
          lastError: null,
        }));
      }
      return null;
    });

    if (storageOnline && device.p2pEnabled && device.serveLocalFiles && await this.isGlobalP2pEnabled(userId)) {
      await this.renewReplicaAvailability(device);
    }
    return { assignment: assignment ? this.toWorkItem(assignment) : null };
  }

  async complete(
    userId: string,
    deviceId: string | undefined,
    assignmentId: string,
    dto: CompleteDeviceStorageReplicaDto,
  ) {
    const device = await this.requireContributingDevice(userId, deviceId);
    const assignment = await this.assignments.findOne({ where: { id: assignmentId, userId, deviceId: device.id } });
    if (!assignment) throw new NotFoundException('Device storage assignment not found');
    if (assignment.contentHash.toLowerCase() !== dto.contentHash.toLowerCase() || BigInt(assignment.sizeBytes) !== BigInt(dto.sizeBytes)) {
      throw new ConflictException('The stored device file does not match its assigned version');
    }
    if (assignment.status === DeviceStorageReplicaStatus.AVAILABLE) {
      return { assignmentId: assignment.id, status: assignment.status, lastVerifiedAt: assignment.lastVerifiedAt };
    }
    if (assignment.status !== DeviceStorageReplicaStatus.DOWNLOADING || !assignment.leaseExpiresAt || assignment.leaseExpiresAt <= new Date()) {
      throw new ConflictException('The device storage assignment is no longer active; request it again');
    }

    const node = await this.nodes.findOne({
      where: { id: assignment.nodeId, userId, workspaceId: IsNull(), deletedAt: IsNull() },
    });
    const version = await this.versions.findOne({ where: { id: assignment.versionId, virtualNodeId: assignment.nodeId } });
    if (!node || !version || version.checksum.toLowerCase() !== assignment.contentHash.toLowerCase() || BigInt(version.size) !== BigInt(assignment.sizeBytes)) {
      throw new NotFoundException('The assigned CloudFusion version is no longer available');
    }
    if (!(await this.permissions.canDownload(userId, node.id))) throw new NotFoundException('The device no longer has access to this file');
    const durableCloudReplica = await this.cloudReplicas.findOne({
      where: {
        storageObjectId: assignment.storageObjectId,
        status: StorageReplicaStatus.HEALTHY,
      },
    });
    if (!durableCloudReplica?.remoteFileId) {
      throw new ConflictException('A healthy cloud replica is required before a device replica can be confirmed');
    }

    const now = new Date();
    assignment.status = DeviceStorageReplicaStatus.AVAILABLE;
    assignment.lastVerifiedAt = now;
    assignment.leaseExpiresAt = null;
    assignment.lastError = null;
    await this.assignments.save(assignment);

    if (device.p2pEnabled && device.serveLocalFiles && await this.isGlobalP2pEnabled(userId)) {
      await this.savePeerAvailability(userId, device.id, assignment, now);
    }
    await this.audit.record(userId, 'DEVICE_REPLICA_STORED', 'DeviceStorageReplica', assignment.id, {
      deviceId: device.id,
      nodeId: node.id,
      versionId: version.id,
      sizeBytes: assignment.sizeBytes,
    });
    return { assignmentId: assignment.id, status: assignment.status, lastVerifiedAt: now };
  }

  private async requireContributingDevice(userId: string, deviceId?: string): Promise<UserDevice> {
    if (!deviceId) throw new UnauthorizedException('A registered device session is required for device storage');
    const device = await this.deviceSessions.getActive(userId, deviceId);
    if (!device.storageContributionEnabled) throw new ForbiddenException('Device storage contribution is disabled');
    return device;
  }

  private async isGlobalP2pEnabled(userId: string): Promise<boolean> {
    const user = await this.users.findOne({ where: { id: userId }, select: { id: true, p2pEnabled: true } });
    return user?.p2pEnabled === true;
  }

  private async sumAssignments(
    assignments: Repository<DeviceStorageReplica>,
    deviceId: string,
    statuses: DeviceStorageReplicaStatus[],
  ): Promise<bigint> {
    const result = await assignments.createQueryBuilder('replica')
      .select('COALESCE(SUM(replica.size_bytes), 0)', 'bytes')
      .where('replica.device_id = :deviceId', { deviceId })
      .andWhere('replica.status IN (:...statuses)', { statuses })
      .getRawOne<{ bytes: string | number }>();
    const value = result?.bytes ?? '0';
    return /^\d+$/.test(String(value)) ? BigInt(value) : 0n;
  }

  private async renewReplicaAvailability(device: UserDevice): Promise<void> {
    const rows = await this.assignments.find({
      where: {
        deviceId: device.id,
        status: DeviceStorageReplicaStatus.AVAILABLE,
      },
      take: 500,
      order: { lastVerifiedAt: 'DESC' },
    });
    for (const row of rows) await this.savePeerAvailability(device.userId, device.id, row, new Date());
  }

  private async savePeerAvailability(
    userId: string,
    deviceId: string,
    assignment: DeviceStorageReplica,
    now: Date,
  ): Promise<void> {
    const value = await this.availability.findOne({
      where: { deviceId, nodeId: assignment.nodeId, versionId: assignment.versionId },
    }) ?? this.availability.create({
      userId,
      deviceId,
      nodeId: assignment.nodeId,
      versionId: assignment.versionId,
      contentHash: assignment.contentHash,
      sizeBytes: assignment.sizeBytes,
      status: DeviceFileAvailabilityStatus.AVAILABLE,
      lastVerifiedAt: now,
      expiresAt: this.addMilliseconds(now, AVAILABILITY_LEASE_MS),
    });
    value.userId = userId;
    value.deviceId = deviceId;
    value.nodeId = assignment.nodeId;
    value.versionId = assignment.versionId;
    value.contentHash = assignment.contentHash;
    value.sizeBytes = assignment.sizeBytes;
    value.status = DeviceFileAvailabilityStatus.AVAILABLE;
    value.lastVerifiedAt = now;
    value.expiresAt = this.addMilliseconds(now, AVAILABILITY_LEASE_MS);
    await this.availability.save(value);
  }

  private toWorkItem(assignment: DeviceStorageReplica): DeviceStorageReplicaWorkItem {
    return {
      assignmentId: assignment.id,
      nodeId: assignment.nodeId,
      versionId: assignment.versionId,
      contentHash: assignment.contentHash,
      sizeBytes: assignment.sizeBytes,
      attempts: assignment.attempts,
    };
  }

  private addMilliseconds(date: Date, milliseconds: number): Date {
    return new Date(date.getTime() + milliseconds);
  }
}
