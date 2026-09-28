import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProtectionAlerts1723000000000 implements MigrationInterface {
  name = 'ProtectionAlerts1723000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE INDEX "IDX_audit_logs_action_created_user" ON "audit_logs" ("action", "created_at" DESC, "user_id")');
    await queryRunner.query(`
      CREATE TABLE "protection_alerts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "kind" character varying(48) NOT NULL,
        "status" character varying(24) NOT NULL DEFAULT 'WARNING',
        "event_count" integer NOT NULL,
        "window_seconds" integer NOT NULL,
        "observed_from" TIMESTAMP WITH TIME ZONE NOT NULL,
        "observed_until" TIMESTAMP WITH TIME ZONE NOT NULL,
        "emergency_snapshot_id" uuid,
        "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_protection_alerts_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_protection_alerts_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_protection_alerts_snapshot" FOREIGN KEY ("emergency_snapshot_id") REFERENCES "snapshots"("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_protection_alerts_status" CHECK ("status" IN ('WARNING', 'RESOLVED')),
        CONSTRAINT "CHK_protection_alerts_counts" CHECK ("event_count" > 0 AND "window_seconds" > 0)
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_protection_alerts_user_created" ON "protection_alerts" ("user_id", "created_at" DESC)');
    await queryRunner.query('CREATE INDEX "IDX_protection_alerts_user_kind_status" ON "protection_alerts" ("user_id", "kind", "status")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."IDX_protection_alerts_user_kind_status"');
    await queryRunner.query('DROP INDEX "public"."IDX_protection_alerts_user_created"');
    await queryRunner.query('DROP TABLE "protection_alerts"');
    await queryRunner.query('DROP INDEX "public"."IDX_audit_logs_action_created_user"');
  }
}
