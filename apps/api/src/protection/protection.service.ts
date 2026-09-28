import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { BackupJob } from '../backups/entities/backup-job.entity';
import { Snapshot } from '../snapshots/entities/snapshot.entity';
import { SnapshotsService } from '../snapshots/snapshots.service';
import { StorageObject } from '../virtual-fs/entities/storage-object.entity';
import { StorageReplica } from '../virtual-fs/entities/storage-replica.entity';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { VirtualNodeStatus } from '../virtual-fs/enums/virtual-node-status.enum';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';
import { StorageReplicaStatus } from '../virtual-fs/enums/storage-replica-status.enum';
import { ProtectionAlert } from './entities/protection-alert.entity';
import { DataProtectionEventsService } from '../realtime/data-protection-events.service';

const MONITORED_ACTIONS = [
  'VIRTUAL_FILE_VERSION_CREATED',
  'VIRTUAL_UPLOAD_QUEUED',
  'VIRTUAL_UPLOAD_DEDUPLICATED',
  'VIRTUAL_NODE_RENAMED',
  'VIRTUAL_NODE_TRASHED',
  'VIRTUAL_NODE_PERMANENT_DELETE_QUEUED',
  'VIRTUAL_NODE_PERMANENTLY_DELETED',
];

@Injectable()
export class ProtectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProtectionService.name);
  private timer?: NodeJS.Timeout;
  private scanning = false;

  constructor(
    @InjectRepository(ProtectionAlert) private readonly alerts: Repository<ProtectionAlert>,
    @InjectRepository(AuditLog) private readonly auditLogs: Repository<AuditLog>,
    @InjectRepository(VirtualNode) private readonly nodes: Repository<VirtualNode>,
    @InjectRepository(FileVersion) private readonly versions: Repository<FileVersion>,
    @InjectRepository(StorageObject) private readonly objects: Repository<StorageObject>,
    @InjectRepository(StorageReplica) private readonly replicas: Repository<StorageReplica>,
    @InjectRepository(Snapshot) private readonly snapshots: Repository<Snapshot>,
    @InjectRepository(BackupJob) private readonly backups: Repository<BackupJob>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly snapshotService: SnapshotsService,
    private readonly protectionEvents?: DataProtectionEventsService,
  ) {}

  onModuleInit(): void {
    const seconds = Math.max(10, this.config.get<number>('dataProtection.massChangeScanIntervalSeconds') ?? 30);
    this.timer = setInterval(() => void this.scanMassChanges().catch((error) => this.logger.warn(`Mass-change scan failed: ${String(error)}`)), seconds * 1000);
    void this.scanMassChanges().catch((error) => this.logger.warn(`Initial mass-change scan failed: ${String(error)}`));
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async listAlerts(userId: string): Promise<ProtectionAlert[]> {
    return this.alerts.find({ where: { userId }, order: { createdAt: 'DESC' }, take: 100 });
  }

  async resolveAlert(userId: string, id: string): Promise<ProtectionAlert> {
    const alert = await this.alerts.findOne({ where: { id, userId } });
    if (!alert) throw new NotFoundException('Protection alert not found');
    alert.status = 'RESOLVED';
    alert.resolvedAt = new Date();
    await this.audit.record(userId, 'PROTECTION_ALERT_RESOLVED', 'ProtectionAlert', id);
    return this.alerts.save(alert);
  }

  async overview(userId: string) {
    const [fileCount, trashedItems, fileVersions, degradedCount, snapshotCount, backupCount, corruptReplicas, logicalRows, physicalRows] = await Promise.all([
      this.nodes.count({ where: { userId, type: VirtualNodeType.FILE, deletedAt: IsNull() } }),
      this.nodes.count({ where: { userId, deletedAt: Not(IsNull()) } }),
      this.versions.count({ where: { createdBy: userId } }),
      this.nodes.count({ where: { userId, status: VirtualNodeStatus.DEGRADED, deletedAt: IsNull() } }),
      this.snapshots.count({ where: { userId, status: 'AVAILABLE' } }),
      this.backups.count({ where: { userId, status: 'COMPLETED' } }),
      this.replicas.createQueryBuilder('replica')
        .innerJoin(StorageObject, 'object', 'object.id = replica.storage_object_id')
        .where('object.user_id = :userId', { userId })
        .andWhere('replica.status = :status', { status: StorageReplicaStatus.CORRUPTED })
        .getCount(),
      this.dataSource.query(`SELECT COALESCE(SUM(node."size"), 0)::text AS "total" FROM "virtual_nodes" node WHERE node."user_id" = $1 AND node."type" = 'FILE' AND node."deleted_at" IS NULL`, [userId]) as Promise<Array<{ total: string }>>,
      this.dataSource.query(`SELECT COALESCE(SUM(object."size"), 0)::text AS "total" FROM "storage_objects" object WHERE object."user_id" = $1 AND object."id" IN (SELECT DISTINCT node."storage_object_id" FROM "virtual_nodes" node WHERE node."user_id" = $1 AND node."type" = 'FILE' AND node."deleted_at" IS NULL AND node."storage_object_id" IS NOT NULL)`, [userId]) as Promise<Array<{ total: string }>>,
    ]);
    const logicalBytes = Number(logicalRows[0]?.total ?? 0);
    const uniqueBytes = Number(physicalRows[0]?.total ?? 0);
    const masterKey = this.config.get<string>('dataProtection.masterKey');
    const keyRing = this.config.get<string>('dataProtection.masterKeysJson');
    return {
      encryption: { configured: Boolean(masterKey || keyRing), algorithm: 'AES-256-GCM', keyVersion: this.config.get<number>('dataProtection.keyVersion') ?? 1 },
      filesProtected: fileCount,
      trashedItems,
      fileVersions,
      snapshots: snapshotCount,
      completedBackups: backupCount,
      degradedFiles: degradedCount,
      corruptedReplicas: corruptReplicas,
      logicalBytes,
      uniqueObjectBytes: uniqueBytes,
      deduplicationSavingsBytes: Math.max(0, logicalBytes - uniqueBytes),
      activeAlerts: await this.alerts.count({ where: { userId, status: 'WARNING' } }),
    };
  }

  async scanMassChanges(): Promise<number> {
    if (this.scanning) return 0;
    this.scanning = true;
    try {
      const windowSeconds = Math.max(10, this.config.get<number>('dataProtection.massChangeWindowSeconds') ?? 120);
      const threshold = Math.max(1, this.config.get<number>('dataProtection.massChangeThreshold') ?? 250);
      const windowStart = new Date(Date.now() - windowSeconds * 1000);
      const candidates = await this.auditLogs.createQueryBuilder('audit')
        .select('audit.userId', 'userId')
        .addSelect('COUNT(*)', 'eventCount')
        .where('audit.createdAt >= :windowStart', { windowStart })
        .andWhere('audit.action IN (:...actions)', { actions: MONITORED_ACTIONS })
        .groupBy('audit.userId')
        .having('COUNT(*) >= :threshold', { threshold })
        .limit(100)
        .getRawMany<{ userId: string; eventCount: string }>();
      let created = 0;
      for (const candidate of candidates) {
        const alert = await this.createAlert(candidate.userId, Number(candidate.eventCount), windowStart, new Date(), windowSeconds);
        if (!alert) continue;
        created += 1;
        await this.audit.record(alert.userId, 'MASS_CHANGE_DETECTED', 'ProtectionAlert', alert.id, { eventCount: alert.eventCount, windowSeconds });
        this.protectionEvents?.emit(alert.userId, 'MASS_CHANGE_DETECTED', alert.id, alert.status, { eventCount: alert.eventCount, windowSeconds });
        if (this.config.get<boolean>('dataProtection.emergencySnapshotEnabled') !== false) await this.makeEmergencySnapshot(alert);
      }
      return created;
    } finally { this.scanning = false; }
  }

  private async createAlert(userId: string, eventCount: number, windowStart: Date, observedUntil: Date, windowSeconds: number): Promise<ProtectionAlert | null> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`mass-change:${userId}`]);
      const existing = await manager.getRepository(ProtectionAlert).findOne({
        where: { userId, kind: 'MASS_FILE_CHANGE', status: 'WARNING', createdAt: MoreThanOrEqual(windowStart) },
      });
      if (existing) {
        existing.eventCount = Math.max(existing.eventCount, eventCount);
        existing.observedUntil = observedUntil;
        await manager.getRepository(ProtectionAlert).save(existing);
        return null;
      }
      return manager.getRepository(ProtectionAlert).save(manager.getRepository(ProtectionAlert).create({
        userId, kind: 'MASS_FILE_CHANGE', status: 'WARNING', eventCount, windowSeconds,
        observedFrom: windowStart, observedUntil, emergencySnapshotId: null, resolvedAt: null,
        details: { actions: MONITORED_ACTIONS },
      }));
    });
  }

  private async makeEmergencySnapshot(alert: ProtectionAlert): Promise<void> {
    try {
      const snapshot = await this.snapshotService.create(alert.userId, {
        name: `Recuperación de emergencia ${alert.createdAt.toISOString()}`,
        description: `Punto generado automáticamente por alerta de cambios masivos (${alert.eventCount} eventos en ${alert.windowSeconds} segundos).`,
        isImmutable: true,
      });
      alert.emergencySnapshotId = snapshot.id;
      alert.details = { ...alert.details, emergencySnapshotStatus: 'AVAILABLE' };
      await this.alerts.save(alert);
    } catch {
      alert.details = { ...alert.details, emergencySnapshotStatus: 'FAILED' };
      await this.alerts.save(alert);
      this.logger.warn(`Emergency snapshot could not be created for alert ${alert.id}`);
    }
  }
}
