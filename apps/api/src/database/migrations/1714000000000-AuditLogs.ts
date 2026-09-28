import { MigrationInterface, QueryRunner } from 'typeorm';

export class AuditLogs1714000000000 implements MigrationInterface {
  name = 'AuditLogs1714000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "audit_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "action" character varying(80) NOT NULL,
        "resource_type" character varying(80) NOT NULL,
        "resource_id" character varying(255),
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_audit_logs_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_audit_logs_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_audit_logs_user_created" ON "audit_logs" ("user_id", "created_at")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_user_created"`);
    await queryRunner.query(`DROP TABLE "audit_logs"`);
  }
}
