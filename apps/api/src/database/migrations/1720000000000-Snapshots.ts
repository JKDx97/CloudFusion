import { MigrationInterface, QueryRunner } from 'typeorm';

export class Snapshots1720000000000 implements MigrationInterface {
  name = 'Snapshots1720000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "snapshots" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "name" character varying(255) NOT NULL,
        "description" text,
        "status" character varying(24) NOT NULL DEFAULT 'CREATING',
        "is_immutable" boolean NOT NULL DEFAULT false,
        "node_count" integer NOT NULL DEFAULT 0,
        "logical_size" bigint NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_snapshots_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_snapshots_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_snapshots_status" CHECK ("status" IN ('CREATING', 'AVAILABLE', 'FAILED', 'DELETING')),
        CONSTRAINT "CHK_snapshots_counts" CHECK ("node_count" >= 0 AND "logical_size" >= 0)
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_snapshots_user_created" ON "snapshots" ("user_id", "created_at" DESC)');
    await queryRunner.query(`
      CREATE TABLE "snapshot_entries" (
        "id" uuid NOT NULL,
        "snapshot_id" uuid NOT NULL,
        "virtual_node_id" uuid,
        "parent_snapshot_entry_id" uuid,
        "file_version_id" uuid,
        "name" character varying(255) NOT NULL,
        "type" character varying(16) NOT NULL,
        "is_root" boolean NOT NULL DEFAULT false,
        "mime_type" character varying(255),
        "size" bigint,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_snapshot_entries_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_snapshot_entries_snapshot" FOREIGN KEY ("snapshot_id") REFERENCES "snapshots"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_snapshot_entries_virtual_node" FOREIGN KEY ("virtual_node_id") REFERENCES "virtual_nodes"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_snapshot_entries_parent" FOREIGN KEY ("parent_snapshot_entry_id") REFERENCES "snapshot_entries"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_snapshot_entries_file_version" FOREIGN KEY ("file_version_id") REFERENCES "file_versions"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_snapshot_entries_type" CHECK (("type" = 'FILE' AND "file_version_id" IS NOT NULL) OR ("type" = 'FOLDER' AND "file_version_id" IS NULL))
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_snapshot_entries_snapshot_parent" ON "snapshot_entries" ("snapshot_id", "parent_snapshot_entry_id")');
    await queryRunner.query('CREATE INDEX "IDX_snapshot_entries_file_version" ON "snapshot_entries" ("file_version_id")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."IDX_snapshot_entries_file_version"');
    await queryRunner.query('DROP INDEX "public"."IDX_snapshot_entries_snapshot_parent"');
    await queryRunner.query('DROP TABLE "snapshot_entries"');
    await queryRunner.query('DROP INDEX "public"."IDX_snapshots_user_created"');
    await queryRunner.query('DROP TABLE "snapshots"');
  }
}
