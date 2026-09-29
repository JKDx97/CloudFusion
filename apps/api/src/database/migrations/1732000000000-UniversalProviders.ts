import { MigrationInterface, QueryRunner } from 'typeorm';

const providers = [
  'DROPBOX',
  'BOX',
  'PCLOUD',
  'MEGA',
  'AWS_S3',
  'CLOUDFLARE_R2',
  'WASABI',
  'BACKBLAZE_B2',
  'DIGITALOCEAN_SPACES',
  'AZURE_BLOB',
  'GOOGLE_CLOUD_STORAGE',
  'ORACLE_OBJECT_STORAGE',
  'IBM_COS',
  'CUSTOM_S3',
  'MEDIAFIRE',
];

const oldProviders = ['GOOGLE_DRIVE', 'ONEDRIVE'];
const oldStatuses = ['CONNECTED', 'REAUTH_REQUIRED', 'DISCONNECTED'];

export class UniversalProviders1732000000000 implements MigrationInterface {
  name = 'UniversalProviders1732000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const provider of providers) {
      await queryRunner.query(`ALTER TYPE "cloud_accounts_provider_enum" ADD VALUE IF NOT EXISTS '${provider}'`);
    }
    for (const status of ['DEGRADED', 'RATE_LIMITED', 'UNAVAILABLE', 'DISABLED']) {
      await queryRunner.query(`ALTER TYPE "cloud_accounts_status_enum" ADD VALUE IF NOT EXISTS '${status}'`);
    }

    await queryRunner.query(`
      ALTER TABLE "cloud_accounts"
      ADD COLUMN "credential_type" character varying(32) NOT NULL DEFAULT 'OAUTH2',
      ADD COLUMN "credentials_encrypted" text,
      ADD COLUMN "configuration_encrypted" text,
      ADD COLUMN "last_health_check_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      CREATE TABLE "storage_targets" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "cloud_account_id" uuid NOT NULL,
        "type" character varying(40) NOT NULL,
        "name" character varying(255) NOT NULL,
        "remote_identifier" character varying(255) NOT NULL,
        "region" character varying(64),
        "endpoint" text,
        "prefix" text NOT NULL DEFAULT '',
        "force_path_style" boolean NOT NULL DEFAULT false,
        "enabled" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_targets_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_storage_targets_cloud_account" FOREIGN KEY ("cloud_account_id") REFERENCES "cloud_accounts"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_storage_targets_account_remote_prefix" UNIQUE ("cloud_account_id", "remote_identifier", "prefix")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_storage_targets_account_enabled" ON "storage_targets" ("cloud_account_id", "enabled")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_storage_targets_account_enabled"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "storage_targets"`);
    await queryRunner.query(`
      ALTER TABLE "cloud_accounts"
      DROP COLUMN "last_health_check_at",
      DROP COLUMN "configuration_encrypted",
      DROP COLUMN "credentials_encrypted",
      DROP COLUMN "credential_type"
    `);

    const newStatusRows = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM "cloud_accounts"
        WHERE "status"::text NOT IN (${oldStatuses.map((status) => `'${status}'`).join(', ')})
      ) AS "exists"
    `) as Array<{ exists: boolean }>;
    if (newStatusRows[0]?.exists) throw new Error('Cannot revert provider health statuses while accounts use them');
    await queryRunner.query(`CREATE TYPE "cloud_accounts_status_enum_legacy" AS ENUM ('CONNECTED', 'REAUTH_REQUIRED', 'DISCONNECTED')`);
    await queryRunner.query(`ALTER TABLE "cloud_accounts" ALTER COLUMN "status" TYPE "cloud_accounts_status_enum_legacy" USING "status"::text::"cloud_accounts_status_enum_legacy"`);
    await queryRunner.query(`DROP TYPE "cloud_accounts_status_enum"`);
    await queryRunner.query(`ALTER TYPE "cloud_accounts_status_enum_legacy" RENAME TO "cloud_accounts_status_enum"`);

    const newProviderRows = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM "cloud_accounts" WHERE "provider"::text NOT IN (${oldProviders.map((provider) => `'${provider}'`).join(', ')})
        UNION ALL SELECT 1 FROM "transfer_jobs" WHERE "source_provider"::text NOT IN (${oldProviders.map((provider) => `'${provider}'`).join(', ')})
        UNION ALL SELECT 1 FROM "transfer_jobs" WHERE "destination_provider"::text NOT IN (${oldProviders.map((provider) => `'${provider}'`).join(', ')})
        UNION ALL SELECT 1 FROM "storage_replicas" WHERE "provider"::text NOT IN (${oldProviders.map((provider) => `'${provider}'`).join(', ')})
        UNION ALL SELECT 1 FROM "backup_copies" WHERE "provider"::text NOT IN (${oldProviders.map((provider) => `'${provider}'`).join(', ')})
      ) AS "exists"
    `) as Array<{ exists: boolean }>;
    if (newProviderRows[0]?.exists) throw new Error('Cannot revert provider identifiers while newer providers have stored data');

    await queryRunner.query(`CREATE TYPE "cloud_accounts_provider_enum_legacy" AS ENUM ('GOOGLE_DRIVE', 'ONEDRIVE')`);
    await queryRunner.query(`ALTER TABLE "cloud_accounts" ALTER COLUMN "provider" TYPE "cloud_accounts_provider_enum_legacy" USING "provider"::text::"cloud_accounts_provider_enum_legacy"`);
    await queryRunner.query(`ALTER TABLE "transfer_jobs" ALTER COLUMN "source_provider" TYPE "cloud_accounts_provider_enum_legacy" USING "source_provider"::text::"cloud_accounts_provider_enum_legacy"`);
    await queryRunner.query(`ALTER TABLE "transfer_jobs" ALTER COLUMN "destination_provider" TYPE "cloud_accounts_provider_enum_legacy" USING "destination_provider"::text::"cloud_accounts_provider_enum_legacy"`);
    await queryRunner.query(`ALTER TABLE "storage_replicas" ALTER COLUMN "provider" TYPE "cloud_accounts_provider_enum_legacy" USING "provider"::text::"cloud_accounts_provider_enum_legacy"`);
    await queryRunner.query(`ALTER TABLE "backup_copies" ALTER COLUMN "provider" TYPE "cloud_accounts_provider_enum_legacy" USING "provider"::text::"cloud_accounts_provider_enum_legacy"`);
    await queryRunner.query(`DROP TYPE "cloud_accounts_provider_enum"`);
    await queryRunner.query(`ALTER TYPE "cloud_accounts_provider_enum_legacy" RENAME TO "cloud_accounts_provider_enum"`);
  }
}
