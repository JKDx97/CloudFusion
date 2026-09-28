import { MigrationInterface, QueryRunner } from 'typeorm';

export class Backups1722000000000 implements MigrationInterface {
  name = 'Backups1722000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "backup_policies" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "name" character varying(120) NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "scope" character varying(24) NOT NULL DEFAULT 'DRIVE',
        "schedule" character varying(24) NOT NULL DEFAULT 'DAILY',
        "retention_days" integer NOT NULL DEFAULT 30,
        "destination_account_id" uuid NOT NULL,
        "mode" character varying(32) NOT NULL DEFAULT 'SNAPSHOT_BACKUP',
        "next_run_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_backup_policies_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_backup_policies_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_backup_policies_destination" FOREIGN KEY ("destination_account_id") REFERENCES "cloud_accounts"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_backup_policies_schedule" CHECK ("schedule" IN ('DAILY', 'WEEKLY', 'MONTHLY')),
        CONSTRAINT "CHK_backup_policies_retention" CHECK ("retention_days" BETWEEN 1 AND 3650)
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_backup_policies_user_enabled_due" ON "backup_policies" ("user_id", "enabled", "next_run_at")');
    await queryRunner.query(`
      CREATE TABLE "backup_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "policy_id" uuid,
        "snapshot_id" uuid,
        "destination_account_id" uuid NOT NULL,
        "status" character varying(32) NOT NULL DEFAULT 'QUEUED',
        "bytes_processed" bigint NOT NULL DEFAULT 0,
        "items_processed" integer NOT NULL DEFAULT 0,
        "errors" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "started_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_backup_jobs_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_backup_jobs_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_backup_jobs_policy" FOREIGN KEY ("policy_id") REFERENCES "backup_policies"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_backup_jobs_snapshot" FOREIGN KEY ("snapshot_id") REFERENCES "snapshots"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_backup_jobs_destination" FOREIGN KEY ("destination_account_id") REFERENCES "cloud_accounts"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_backup_jobs_status" CHECK ("status" IN ('QUEUED', 'PREPARING', 'RUNNING', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED')),
        CONSTRAINT "CHK_backup_jobs_progress" CHECK ("bytes_processed" >= 0 AND "items_processed" >= 0)
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_backup_jobs_user_created" ON "backup_jobs" ("user_id", "created_at" DESC)');
    await queryRunner.query('CREATE INDEX "IDX_backup_jobs_policy_created" ON "backup_jobs" ("policy_id", "created_at" DESC)');
    await queryRunner.query(`
      CREATE TABLE "backup_copies" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "backup_job_id" uuid NOT NULL,
        "snapshot_entry_id" uuid NOT NULL,
        "file_version_id" uuid NOT NULL,
        "storage_object_id" uuid NOT NULL,
        "destination_account_id" uuid NOT NULL,
        "provider" "cloud_accounts_provider_enum" NOT NULL,
        "remote_file_id" character varying(1024) NOT NULL,
        "size" bigint NOT NULL,
        "encrypted_checksum" character varying(128) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_backup_copies_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_backup_copies_job" FOREIGN KEY ("backup_job_id") REFERENCES "backup_jobs"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_backup_copies_entry" FOREIGN KEY ("snapshot_entry_id") REFERENCES "snapshot_entries"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_backup_copies_version" FOREIGN KEY ("file_version_id") REFERENCES "file_versions"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_backup_copies_object" FOREIGN KEY ("storage_object_id") REFERENCES "storage_objects"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_backup_copies_destination" FOREIGN KEY ("destination_account_id") REFERENCES "cloud_accounts"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_backup_copies_job_object" ON "backup_copies" ("backup_job_id", "storage_object_id")');
    await queryRunner.query('CREATE INDEX "IDX_backup_copies_file_version" ON "backup_copies" ("file_version_id")');
    await queryRunner.query('CREATE INDEX "IDX_backup_copies_storage_object" ON "backup_copies" ("storage_object_id")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."IDX_backup_copies_storage_object"');
    await queryRunner.query('DROP INDEX "public"."IDX_backup_copies_file_version"');
    await queryRunner.query('DROP INDEX "public"."UQ_backup_copies_job_object"');
    await queryRunner.query('DROP TABLE "backup_copies"');
    await queryRunner.query('DROP INDEX "public"."IDX_backup_jobs_policy_created"');
    await queryRunner.query('DROP INDEX "public"."IDX_backup_jobs_user_created"');
    await queryRunner.query('DROP TABLE "backup_jobs"');
    await queryRunner.query('DROP INDEX "public"."IDX_backup_policies_user_enabled_due"');
    await queryRunner.query('DROP TABLE "backup_policies"');
  }
}
