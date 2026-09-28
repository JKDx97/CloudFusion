import { MigrationInterface, QueryRunner } from 'typeorm';

export class CloudAccounts1711000000000 implements MigrationInterface {
  name = 'CloudAccounts1711000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "cloud_accounts_provider_enum" AS ENUM ('GOOGLE_DRIVE', 'ONEDRIVE')`);
    await queryRunner.query(`CREATE TYPE "cloud_accounts_status_enum" AS ENUM ('CONNECTED', 'REAUTH_REQUIRED', 'DISCONNECTED')`);
    await queryRunner.query(`
      CREATE TABLE "cloud_accounts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "provider" "cloud_accounts_provider_enum" NOT NULL,
        "provider_account_id" character varying(255) NOT NULL,
        "email" character varying(255),
        "display_name" character varying(255),
        "access_token_encrypted" text NOT NULL,
        "refresh_token_encrypted" text,
        "token_expires_at" TIMESTAMP WITH TIME ZONE,
        "scopes" text[] NOT NULL DEFAULT '{}',
        "status" "cloud_accounts_status_enum" NOT NULL DEFAULT 'CONNECTED',
        "storage_total" bigint,
        "storage_used" bigint,
        "last_sync_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cloud_accounts_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_cloud_accounts_owner_provider_account" UNIQUE ("user_id", "provider", "provider_account_id"),
        CONSTRAINT "FK_cloud_accounts_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_cloud_accounts_user_id" ON "cloud_accounts" ("user_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_cloud_accounts_user_id"`);
    await queryRunner.query(`DROP TABLE "cloud_accounts"`);
    await queryRunner.query(`DROP TYPE "cloud_accounts_status_enum"`);
    await queryRunner.query(`DROP TYPE "cloud_accounts_provider_enum"`);
  }
}
