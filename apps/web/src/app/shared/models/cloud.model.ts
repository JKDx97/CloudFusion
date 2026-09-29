export type CloudProvider = 'GOOGLE_DRIVE' | 'ONEDRIVE';
export type CloudAccountStatus = 'CONNECTED' | 'REAUTH_REQUIRED' | 'DISCONNECTED';

export interface CloudStorage {
  used: number;
  total: number | null;
}

export interface CloudAccount {
  id: string;
  provider: CloudProvider;
  email: string | null;
  displayName: string | null;
  status: CloudAccountStatus;
  storage: CloudStorage;
  scopes: string[];
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudStorageSummary {
  accounts: CloudAccount[];
  total: CloudStorage;
}

export interface CloudFile {
  id: string;
  provider: CloudProvider;
  accountId: string;
  name: string;
  mimeType?: string;
  type: 'file' | 'folder';
  size?: number;
  parentId?: string;
  createdAt?: string;
  modifiedAt?: string;
  webUrl?: string;
  thumbnailUrl?: string;
}

export type TransferOperation = 'COPY' | 'MOVE';

export type VirtualNodeType = 'FILE' | 'FOLDER';
export type VirtualNodeStatus = 'AVAILABLE' | 'UPLOADING' | 'DEGRADED' | 'UNAVAILABLE' | 'DELETING' | 'ERROR';

export interface VirtualNode {
  id: string;
  userId: string;
  parentId: string | null;
  name: string;
  type: VirtualNodeType;
  mimeType: string | null;
  size: number | null;
  status: VirtualNodeStatus;
  storageObjectId: string | null;
  currentVersionId: string | null;
  isRoot: boolean;
  isFavorite: boolean;
  deletedAt: string | null;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ResourceShareRole = 'VIEWER' | 'EDITOR';

export interface ResourceShareRecord {
  id: string;
  node: Pick<VirtualNode, 'id' | 'name' | 'type' | 'mimeType' | 'size' | 'parentId'>;
  role: ResourceShareRole;
  status: 'ACTIVE' | 'REVOKED';
  createdAt: string;
  updatedAt: string;
  user: { id: string; username: string; email: string } | null;
}

export interface SharePage {
  items: ResourceShareRecord[];
  page: number;
  limit: number;
  total: number;
}

export interface ShareUser {
  id: string;
  username: string;
  email: string;
}

export interface ShareUserSearchResult {
  items: ShareUser[];
  page: number;
  limit: number;
  total: number;
}

export interface FileVersionRecord {
  id: string;
  versionNumber: number;
  size: number;
  checksum: string;
  createdAt: string;
  comment: string | null;
  current: boolean;
}

export interface SnapshotRecord {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  status: 'CREATING' | 'AVAILABLE' | 'FAILED' | 'DELETING';
  isImmutable: boolean;
  nodeCount: number;
  logicalSize: string;
  createdAt: string;
  completedAt: string | null;
}

export interface SnapshotEntryRecord {
  id: string;
  parentEntryId: string | null;
  virtualNodeId: string | null;
  fileVersionId: string | null;
  name: string;
  type: 'FILE' | 'FOLDER';
  isRoot: boolean;
  mimeType: string | null;
  size: number | null;
}

export interface SnapshotRestoreJobRecord {
  id: string;
  snapshotId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  totalEntries: number;
  processedEntries: number;
  entryMappings: Record<string, string>;
  errors: Array<{ entryId: string; message: string }>;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BackupPolicyRecord {
  id: string;
  name: string;
  enabled: boolean;
  scope: string;
  schedule: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  retentionDays: number;
  destinationAccountId: string;
  mode: string;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupJobRecord {
  id: string;
  policyId: string | null;
  snapshotId: string | null;
  destinationAccountId: string;
  status: 'QUEUED' | 'PREPARING' | 'RUNNING' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  bytesProcessed: string;
  itemsProcessed: number;
  errors: Array<{ entryId: string; message: string }>;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  verifiedObjects?: number;
}

export interface ProtectionAlertRecord {
  id: string;
  kind: string;
  status: 'WARNING' | 'RESOLVED';
  eventCount: number;
  windowSeconds: number;
  emergencySnapshotId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
}

export interface DataProtectionEventRecord {
  type: 'ENCRYPTION_COMPLETED' | 'VERSION_CREATED' | 'SNAPSHOT_STARTED' | 'SNAPSHOT_COMPLETED' | 'SNAPSHOT_FAILED'
    | 'BACKUP_STARTED' | 'BACKUP_PROGRESS' | 'BACKUP_COMPLETED' | 'BACKUP_FAILED'
    | 'RESTORE_STARTED' | 'RESTORE_PROGRESS' | 'RESTORE_COMPLETED' | 'RESTORE_FAILED'
    | 'MASS_CHANGE_DETECTED' | 'HEARTBEAT';
  entityId: string | null;
  status?: string;
  progress?: number;
  occurredAt: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface ProtectionOverviewRecord {
  encryption: { configured: boolean; algorithm: string; keyVersion: number };
  filesProtected: number;
  trashedItems: number;
  fileVersions: number;
  snapshots: number;
  completedBackups: number;
  degradedFiles: number;
  corruptedReplicas: number;
  logicalBytes: number;
  uniqueObjectBytes: number;
  deduplicationSavingsBytes: number;
  activeAlerts: number;
}

export interface CloudAccountImpactRecord {
  accountId: string;
  replicas: number;
  objectsOnlyOnThisAccount: number;
  versionsAtRisk: number;
  snapshotEntriesAtRisk: number;
  activeBackupPolicies: number;
  verifiedBackupsStored: number;
  requiresConfirmation: boolean;
}
export type TransferStatus = 'QUEUED' | 'PREPARING' | 'TRANSFERRING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'RETRYING';
export type ConflictStrategy = 'RENAME' | 'OVERWRITE' | 'SKIP';

export interface TransferJob {
  id: string;
  sourceAccountId: string;
  sourceProvider: CloudProvider;
  sourceFileId: string;
  destinationAccountId: string;
  destinationProvider: CloudProvider;
  destinationFolderId: string | null;
  operation: TransferOperation;
  conflictStrategy: ConflictStrategy;
  parentJobId: string | null;
  relativePath: string | null;
  fileName: string;
  fileSize: number | null;
  status: TransferStatus;
  progress: number;
  bytesTransferred: number;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface TransferProgressEvent {
  transferId: string;
  status: TransferStatus;
  progress: number;
  bytesTransferred: number;
  fileSize: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export type StorageRuleConditionType = 'EXTENSION' | 'MIME' | 'SIZE_GREATER_THAN' | 'DEFAULT';

export interface StorageRule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  conditionType: StorageRuleConditionType;
  conditionValue: string | null;
  destinationAccountId: string;
  destinationFolderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudSearchResponse {
  query: string;
  results: CloudFile[];
  failures: { accountId: string; provider: CloudProvider; message: string }[];
}
