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
});
