import { MigrationInterface, QueryRunner } from 'typeorm';

export class FileVersions1719000000000 implements MigrationInterface {
  name = 'FileVersions1719000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "file_versions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "virtual_node_id" uuid,
        "storage_object_id" uuid NOT NULL,
        "version_number" integer NOT NULL,
        "size" bigint NOT NULL,
        "checksum" character varying(128) NOT NULL,
        "created_by" uuid NOT NULL,
        "comment" character varying(500),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_file_versions_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_file_versions_virtual_node" FOREIGN KEY ("virtual_node_id") REFERENCES "virtual_nodes"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_file_versions_storage_object" FOREIGN KEY ("storage_object_id") REFERENCES "storage_objects"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_file_versions_storage_object" ON "file_versions" ("storage_object_id")');
    await queryRunner.query('CREATE INDEX "IDX_file_versions_node_created" ON "file_versions" ("virtual_node_id", "created_at")');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_file_versions_node_number" ON "file_versions" ("virtual_node_id", "version_number") WHERE "virtual_node_id" IS NOT NULL');
    await queryRunner.query('ALTER TABLE "virtual_nodes" ADD COLUMN "current_version_id" uuid');
    await queryRunner.query(`
      WITH "created_versions" AS (
        INSERT INTO "file_versions" ("virtual_node_id", "storage_object_id", "version_number", "size", "checksum", "created_by", "created_at")
        SELECT node."id", object."id", 1, COALESCE(node."size", object."size"), object."checksum", node."user_id", node."created_at"
        FROM "virtual_nodes" node
        JOIN "storage_objects" object ON object."id" = node."storage_object_id"
        WHERE node."type" = 'FILE'
        RETURNING "id", "virtual_node_id"
      )
      UPDATE "virtual_nodes" node
      SET "current_version_id" = created."id"
      FROM "created_versions" created
      WHERE node."id" = created."virtual_node_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "virtual_nodes"
      ADD CONSTRAINT "FK_virtual_nodes_current_version"
      FOREIGN KEY ("current_version_id") REFERENCES "file_versions"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      UPDATE "storage_objects" object
      SET "reference_count" = (
        SELECT COUNT(*)::integer FROM "file_versions" version
        WHERE version."storage_object_id" = object."id"
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "storage_objects" object
      SET "reference_count" = (
        SELECT COUNT(*)::integer FROM "virtual_nodes" node
        WHERE node."storage_object_id" = object."id"
      )
    `);
    await queryRunner.query('ALTER TABLE "virtual_nodes" DROP CONSTRAINT "FK_virtual_nodes_current_version", DROP COLUMN "current_version_id"');
    await queryRunner.query('DROP INDEX "public"."UQ_file_versions_node_number"');
    await queryRunner.query('DROP INDEX "public"."IDX_file_versions_node_created"');
    await queryRunner.query('DROP INDEX "public"."IDX_file_versions_storage_object"');
    await queryRunner.query('DROP TABLE "file_versions"');
  }
}
