export default () => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:4200',
  },
  api: {
    port: Number(process.env.API_PORT ?? 3000),
  },
  database: {
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5432),
    name: process.env.DATABASE_NAME ?? 'cloudfusion',
    user: process.env.DATABASE_USER ?? 'cloudfusion',
    password: process.env.DATABASE_PASSWORD ?? 'change_me_local',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
  jwt: {
    accessSecret:
      process.env.JWT_ACCESS_SECRET ??
      'change_me_access_secret_at_least_32_characters',
    refreshSecret:
      process.env.JWT_REFRESH_SECRET ??
      'change_me_refresh_secret_at_least_32_characters',
    accessExpiration: process.env.JWT_ACCESS_EXPIRATION ?? '15m',
    refreshExpiration: process.env.JWT_REFRESH_EXPIRATION ?? '7d',
  },
  cloud: {
    tokenEncryptionKey: process.env.CLOUD_TOKEN_ENCRYPTION_KEY,
    uploadMaxBytes: Number(process.env.CLOUD_UPLOAD_MAX_BYTES ?? 52_428_800),
    oauthStateTtlSeconds: Number(
      process.env.CLOUD_OAUTH_STATE_TTL_SECONDS ?? 600,
    ),
    frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:4200',
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri:
        process.env.GOOGLE_REDIRECT_URI ??
        'http://localhost:3000/cloud-accounts/google/callback',
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      tenantId: process.env.MICROSOFT_TENANT_ID ?? 'common',
      redirectUri:
        process.env.MICROSOFT_REDIRECT_URI ??
        'http://localhost:3000/cloud-accounts/onedrive/callback',
    },
  },
  transfer: {
    queueName: process.env.TRANSFER_QUEUE_NAME ?? 'cloudfusion-transfers',
    workerEnabled: process.env.TRANSFER_WORKER_ENABLED !== 'false',
    workerConcurrency: Number(process.env.TRANSFER_WORKER_CONCURRENCY ?? 3),
    maxRetries: Number(process.env.TRANSFER_MAX_RETRIES ?? 3),
    progressIntervalMs: Number(process.env.TRANSFER_PROGRESS_INTERVAL_MS ?? 1000),
  },
  virtualDrive: {
    queueName: process.env.REPLICATION_QUEUE_NAME ?? 'cloudfusion-replication',
    workerEnabled: process.env.REPLICATION_WORKER_ENABLED !== 'false',
    defaultReplicationFactor: Number(process.env.DEFAULT_REPLICATION_FACTOR ?? 1),
    autoRepair: process.env.REPLICA_AUTO_REPAIR !== 'false',
    verifyIntervalHours: Number(process.env.REPLICA_VERIFY_INTERVAL_HOURS ?? 24),
    replicationWorkerConcurrency: Number(process.env.REPLICATION_WORKER_CONCURRENCY ?? 2),
    trashRetentionDays: Number(process.env.TRASH_RETENTION_DAYS ?? 30),
    rebalanceEnabled: process.env.STORAGE_REBALANCE_ENABLED !== 'false',
  },
  dataProtection: {
    masterKey: process.env.CLOUDFUSION_MASTER_KEY,
    keyVersion: Number(process.env.CLOUDFUSION_KEY_VERSION ?? 1),
    masterKeysJson: process.env.CLOUDFUSION_MASTER_KEYS_JSON,
    retentionMode: process.env.DEFAULT_VERSION_RETENTION_MODE ?? 'KEEP_LAST_N',
    retentionCount: Number(process.env.DEFAULT_VERSION_RETENTION_COUNT ?? 10),
    snapshotSchedulerEnabled: process.env.SNAPSHOT_SCHEDULER_ENABLED !== 'false',
    snapshotRestoreQueueName: process.env.SNAPSHOT_RESTORE_QUEUE_NAME ?? 'cloudfusion-snapshot-restores',
    snapshotRestoreWorkerEnabled: process.env.SNAPSHOT_RESTORE_WORKER_ENABLED !== 'false',
    snapshotRestoreWorkerConcurrency: Number(process.env.SNAPSHOT_RESTORE_WORKER_CONCURRENCY ?? 1),
    snapshotRestoreMaxRetries: Number(process.env.SNAPSHOT_RESTORE_MAX_RETRIES ?? 3),
    emergencySnapshotEnabled: process.env.EMERGENCY_SNAPSHOT_ENABLED !== 'false',
    massChangeWindowSeconds: Number(process.env.MASS_CHANGE_WINDOW_SECONDS ?? 120),
    massChangeThreshold: Number(process.env.MASS_CHANGE_THRESHOLD ?? 250),
    storageGcEnabled: process.env.STORAGE_GC_ENABLED !== 'false',
    storageGcGraceHours: Number(process.env.STORAGE_GC_GRACE_HOURS ?? 24),
    storageGcIntervalMinutes: Number(process.env.STORAGE_GC_INTERVAL_MINUTES ?? 60),
    backupWorkerConcurrency: Number(process.env.BACKUP_WORKER_CONCURRENCY ?? 2),
    backupMaxRetries: Number(process.env.BACKUP_MAX_RETRIES ?? 3),
  },
});
