import { MigrationInterface, QueryRunner } from 'typeorm';

export class TransferJobs1712000000000 implements MigrationInterface {
  name = 'TransferJobs1712000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "transfer_jobs_operation_enum" AS ENUM ('COPY', 'MOVE')`);
    await queryRunner.query(`CREATE TYPE "transfer_jobs_status_enum" AS ENUM ('QUEUED', 'PREPARING', 'TRANSFERRING', 'COMPLETED', 'FAILED', 'CANCELLED', 'RETRYING')`);
    await queryRunner.query(`CREATE TYPE "transfer_jobs_conflict_strategy_enum" AS ENUM ('RENAME', 'OVERWRITE', 'SKIP')`);
    await queryRunner.query(`
      CREATE TABLE "transfer_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "source_account_id" uuid NOT NULL,
        "source_provider" "cloud_accounts_provider_enum" NOT NULL,
        "source_file_id" character varying(1024) NOT NULL,
        "destination_account_id" uuid NOT NULL,
        "destination_provider" "cloud_accounts_provider_enum" NOT NULL,
        "destination_folder_id" character varying(1024),
        "operation" "transfer_jobs_operation_enum" NOT NULL,
        "conflict_strategy" "transfer_jobs_conflict_strategy_enum" NOT NULL DEFAULT 'RENAME',
        "parent_job_id" uuid,
        "relative_path" text,
        "file_name" character varying(1024) NOT NULL,
        "file_size" bigint,
        "status" "transfer_jobs_status_enum" NOT NULL DEFAULT 'QUEUED',
        "progress" integer NOT NULL DEFAULT 0,
        "bytes_transferred" bigint NOT NULL DEFAULT 0,
        "attempt_count" integer NOT NULL DEFAULT 0,
        "error_code" character varying(100),
        "error_message" text,
        "cancel_requested" boolean NOT NULL DEFAULT false,
        "started_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_transfer_jobs_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_transfer_jobs_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_transfer_jobs_parent" FOREIGN KEY ("parent_job_id") REFERENCES "transfer_jobs"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_transfer_jobs_user_created" ON "transfer_jobs" ("user_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_transfer_jobs_user_status" ON "transfer_jobs" ("user_id", "status")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_transfer_jobs_user_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_transfer_jobs_user_created"`);
    await queryRunner.query(`DROP TABLE "transfer_jobs"`);
    await queryRunner.query(`DROP TYPE "transfer_jobs_conflict_strategy_enum"`);
    await queryRunner.query(`DROP TYPE "transfer_jobs_status_enum"`);
    await queryRunner.query(`DROP TYPE "transfer_jobs_operation_enum"`);
  }
}
