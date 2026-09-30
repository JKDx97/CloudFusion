import 'dotenv/config';
import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { CloudAccount } from '../cloud-accounts/entities/cloud-account.entity';
import { TransferJob } from '../transfers/entities/transfer-job.entity';
import { StorageRule } from '../storage-rules/entities/storage-rule.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { StorageObject } from '../virtual-fs/entities/storage-object.entity';
import { StorageReplica } from '../virtual-fs/entities/storage-replica.entity';
import { StoragePolicy } from '../virtual-fs/entities/storage-policy.entity';
import { FileVersion } from '../virtual-fs/entities/file-version.entity';
import { Snapshot } from '../snapshots/entities/snapshot.entity';
import { SnapshotEntry } from '../snapshots/entities/snapshot-entry.entity';
import { SnapshotRestoreJob } from '../snapshots/entities/snapshot-restore-job.entity';
import { BackupPolicy } from '../backups/entities/backup-policy.entity';
import { BackupJob } from '../backups/entities/backup-job.entity';
import { BackupCopy } from '../backups/entities/backup-copy.entity';
import { ProtectionAlert } from '../protection/entities/protection-alert.entity';
import { ApiToken } from '../api-tokens/entities/api-token.entity';
import { ResourceShare } from '../permissions/entities/resource-share.entity';
import { StorageTarget } from '../providers/object-storage/entities/storage-target.entity';
import { UserDevice } from '../devices/entities/user-device.entity';
import { DevicePairingCode } from '../devices/entities/device-pairing-code.entity';
import { DeviceFileAvailability } from '../p2p/entities/device-file-availability.entity';
import { PeerTransferSession } from '../p2p/entities/peer-transfer-session.entity';

export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  username: process.env.DATABASE_USER ?? 'cloudfusion',
  password: process.env.DATABASE_PASSWORD ?? 'change_me_local',
  database: process.env.DATABASE_NAME ?? 'cloudfusion',
  entities: [User, CloudAccount, TransferJob, StorageRule, AuditLog, VirtualNode, StorageObject, StorageReplica, StoragePolicy, FileVersion, Snapshot, SnapshotEntry, SnapshotRestoreJob, BackupPolicy, BackupJob, BackupCopy, ProtectionAlert, ApiToken, ResourceShare, StorageTarget, UserDevice, DevicePairingCode, DeviceFileAvailability, PeerTransferSession],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
});
