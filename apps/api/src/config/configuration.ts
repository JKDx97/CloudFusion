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
});
