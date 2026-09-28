import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BackupCopy } from '../backups/entities/backup-copy.entity';
import { BackupPolicy } from '../backups/entities/backup-policy.entity';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { StorageReplica } from '../virtual-fs/entities/storage-replica.entity';
import { StorageReplicaStatus } from '../virtual-fs/enums/storage-replica-status.enum';
import { SnapshotEntry } from '../snapshots/entities/snapshot-entry.entity';
import { CloudAccount } from './entities/cloud-account.entity';

export interface CloudAccountImpact {
  accountId: string;
  replicas: number;
  objectsOnlyOnThisAccount: number;
  versionsAtRisk: number;
  snapshotEntriesAtRisk: number;
  activeBackupPolicies: number;
  verifiedBackupsStored: number;
  requiresConfirmation: boolean;
}

@Injectable()
export class AccountImpactService {
  constructor(
    @InjectRepository(CloudAccount) private readonly accounts: Repository<CloudAccount>,
    @InjectRepository(StorageReplica) private readonly replicas: Repository<StorageReplica>,
    @InjectRepository(FileVersion) private readonly versions: Repository<FileVersion>,
    @InjectRepository(SnapshotEntry) private readonly snapshotEntries: Repository<SnapshotEntry>,
    @InjectRepository(BackupPolicy) private readonly policies: Repository<BackupPolicy>,
    @InjectRepository(BackupCopy) private readonly backupCopies: Repository<BackupCopy>,
  ) {}

  async inspect(userId: string, accountId: string): Promise<CloudAccountImpact> {
    const account = await this.accounts.findOne({ where: { id: accountId, userId } });
    if (!account) throw new NotFoundException('Cloud account not found');
    const ownedReplicas = await this.replicas.createQueryBuilder('replica')
      .innerJoin('storage_objects', 'object', 'object.id = replica.storage_object_id')
      .where('object.user_id = :userId', { userId })
      .andWhere('replica.cloud_account_id = :accountId', { accountId })
      .getMany();
    const objectIds = [...new Set(ownedReplicas.map((replica) => replica.storageObjectId))];
    let objectsOnlyOnThisAccount = 0;
    let versionsAtRisk = 0;
    let snapshotEntriesAtRisk = 0;
    if (objectIds.length) {
      const otherReplicas = await this.replicas.createQueryBuilder('replica')
        .innerJoin(CloudAccount, 'account', 'account.id = replica.cloud_account_id')
        .where('replica.storage_object_id IN (:...objectIds)', { objectIds })
        .andWhere('replica.cloud_account_id != :accountId', { accountId })
        .andWhere('replica.status = :healthy', { healthy: StorageReplicaStatus.HEALTHY })
        .andWhere('account.status = :connected', { connected: 'CONNECTED' })
        .select('DISTINCT replica.storage_object_id', 'objectId')
        .getRawMany<{ objectId: string }>();
      const recoverable = new Set(otherReplicas.map((replica) => replica.objectId));
      const atRisk = objectIds.filter((id) => !recoverable.has(id));
      objectsOnlyOnThisAccount = atRisk.length;
      if (atRisk.length) {
        const atRiskVersions = await this.versions.find({ where: { storageObjectId: In(atRisk) }, select: { id: true } });
        versionsAtRisk = atRiskVersions.length;
        if (atRiskVersions.length) snapshotEntriesAtRisk = await this.snapshotEntries.count({ where: { fileVersionId: In(atRiskVersions.map((version) => version.id)) } });
      }
    }
    const activeBackupPolicies = await this.policies.count({ where: { userId, destinationAccountId: accountId, enabled: true } });
    const verifiedBackupsStored = await this.backupCopies.count({ where: { destinationAccountId: accountId } });
    return {
      accountId,
      replicas: ownedReplicas.length,
      objectsOnlyOnThisAccount,
      versionsAtRisk,
      snapshotEntriesAtRisk,
      activeBackupPolicies,
      verifiedBackupsStored,
      requiresConfirmation: objectsOnlyOnThisAccount > 0 || activeBackupPolicies > 0 || verifiedBackupsStored > 0,
    };
  }
}
