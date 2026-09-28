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
