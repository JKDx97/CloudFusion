import { MigrationInterface, QueryRunner } from 'typeorm';

export class SnapshotRestoreJobs1721000000000 implements MigrationInterface {
  name = 'SnapshotRestoreJobs1721000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "snapshot_restore_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "snapshot_id" uuid NOT NULL,
        "status" character varying(24) NOT NULL DEFAULT 'QUEUED',
        "total_entries" integer NOT NULL DEFAULT 0,
        "processed_entries" integer NOT NULL DEFAULT 0,
        "entry_mappings" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "errors" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "started_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_snapshot_restore_jobs_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_snapshot_restore_jobs_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_snapshot_restore_jobs_snapshot" FOREIGN KEY ("snapshot_id") REFERENCES "snapshots"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_snapshot_restore_jobs_status" CHECK ("status" IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
        CONSTRAINT "CHK_snapshot_restore_jobs_progress" CHECK ("total_entries" >= 0 AND "processed_entries" >= 0 AND "processed_entries" <= "total_entries")
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_snapshot_restore_jobs_user_created" ON "snapshot_restore_jobs" ("user_id", "created_at" DESC)');
    await queryRunner.query('CREATE INDEX "IDX_snapshot_restore_jobs_snapshot_status" ON "snapshot_restore_jobs" ("snapshot_id", "status")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."IDX_snapshot_restore_jobs_snapshot_status"');
    await queryRunner.query('DROP INDEX "public"."IDX_snapshot_restore_jobs_user_created"');
    await queryRunner.query('DROP TABLE "snapshot_restore_jobs"');
  }
}
