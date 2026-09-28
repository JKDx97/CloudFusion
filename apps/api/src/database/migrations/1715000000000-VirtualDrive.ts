import { MigrationInterface, QueryRunner } from 'typeorm';

export class VirtualDrive1715000000000 implements MigrationInterface {
  name = 'VirtualDrive1715000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "storage_policies_type_enum" AS ENUM ('STANDARD', 'REDUNDANT', 'ARCHIVE', 'CUSTOM')`);
    await queryRunner.query(`CREATE TYPE "virtual_nodes_type_enum" AS ENUM ('FILE', 'FOLDER')`);
    await queryRunner.query(`CREATE TYPE "virtual_nodes_status_enum" AS ENUM ('AVAILABLE', 'UPLOADING', 'DEGRADED', 'UNAVAILABLE', 'DELETING', 'ERROR')`);
    await queryRunner.query(`CREATE TYPE "storage_objects_status_enum" AS ENUM ('AVAILABLE', 'UPLOADING', 'DEGRADED', 'UNAVAILABLE', 'DELETING', 'ERROR')`);
    await queryRunner.query(`CREATE TYPE "storage_replicas_status_enum" AS ENUM ('PENDING', 'UPLOADING', 'HEALTHY', 'DEGRADED', 'MISSING', 'CORRUPTED', 'FAILED', 'DELETING', 'REPAIRING')`);

    await queryRunner.query(`
      CREATE TABLE "storage_policies" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "name" character varying(120) NOT NULL,
        "type" "storage_policies_type_enum" NOT NULL,
        "replication_factor" integer NOT NULL DEFAULT 1,
        "enabled" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_policies_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_storage_policies_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_storage_policies_replication_factor" CHECK ("replication_factor" BETWEEN 1 AND 8),
        CONSTRAINT "UQ_storage_policies_user_name" UNIQUE ("user_id", "name")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_storage_policies_user" ON "storage_policies" ("user_id")`);

    await queryRunner.query(`
      CREATE TABLE "storage_objects" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "storage_key" character varying(255) NOT NULL,
        "size" bigint NOT NULL,
        "mime_type" character varying(255),
        "checksum" character varying(128) NOT NULL,
        "checksum_algorithm" character varying(32) NOT NULL DEFAULT 'SHA-256',
        "status" "storage_objects_status_enum" NOT NULL DEFAULT 'UPLOADING',
        "policy_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_objects_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_storage_objects_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_storage_objects_policy" FOREIGN KEY ("policy_id") REFERENCES "storage_policies"("id") ON DELETE SET NULL,
        CONSTRAINT "UQ_storage_objects_storage_key" UNIQUE ("storage_key")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_storage_objects_user" ON "storage_objects" ("user_id")`);

    await queryRunner.query(`
      CREATE TABLE "virtual_nodes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "parent_id" uuid,
        "name" character varying(255) NOT NULL,
        "type" "virtual_nodes_type_enum" NOT NULL,
        "mime_type" character varying(255),
        "size" bigint,
        "status" "virtual_nodes_status_enum" NOT NULL DEFAULT 'AVAILABLE',
        "storage_object_id" uuid,
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "previous_parent_id" uuid,
        "is_root" boolean NOT NULL DEFAULT false,
        "is_favorite" boolean NOT NULL DEFAULT false,
        "last_accessed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_virtual_nodes_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_virtual_nodes_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_virtual_nodes_parent" FOREIGN KEY ("parent_id") REFERENCES "virtual_nodes"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_virtual_nodes_storage_object" FOREIGN KEY ("storage_object_id") REFERENCES "storage_objects"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_virtual_nodes_user_parent" ON "virtual_nodes" ("user_id", "parent_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_virtual_nodes_user_recent" ON "virtual_nodes" ("user_id", "last_accessed_at")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_virtual_nodes_user_parent_name_active" ON "virtual_nodes" ("user_id", "parent_id", "name") WHERE "deleted_at" IS NULL`);

    await queryRunner.query(`
      CREATE TABLE "storage_replicas" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "storage_object_id" uuid NOT NULL,
        "cloud_account_id" uuid NOT NULL,
        "provider" "cloud_accounts_provider_enum" NOT NULL,
        "remote_file_id" character varying(1024),
        "remote_parent_id" character varying(1024),
        "status" "storage_replicas_status_enum" NOT NULL DEFAULT 'PENDING',
        "size" bigint,
        "checksum" character varying(128),
        "last_verified_at" TIMESTAMP WITH TIME ZONE,
        "last_error" text,
        "attempts" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_replicas_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_storage_replicas_object" FOREIGN KEY ("storage_object_id") REFERENCES "storage_objects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_storage_replicas_account" FOREIGN KEY ("cloud_account_id") REFERENCES "cloud_accounts"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_storage_replicas_object_status" ON "storage_replicas" ("storage_object_id", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_storage_replicas_account" ON "storage_replicas" ("cloud_account_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_storage_replicas_account"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_storage_replicas_object_status"`);
    await queryRunner.query(`DROP TABLE "storage_replicas"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_virtual_nodes_user_parent_name_active"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_virtual_nodes_user_recent"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_virtual_nodes_user_parent"`);
    await queryRunner.query(`DROP TABLE "virtual_nodes"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_storage_objects_user"`);
    await queryRunner.query(`DROP TABLE "storage_objects"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_storage_policies_user"`);
    await queryRunner.query(`DROP TABLE "storage_policies"`);
    await queryRunner.query(`DROP TYPE "storage_replicas_status_enum"`);
    await queryRunner.query(`DROP TYPE "storage_objects_status_enum"`);
    await queryRunner.query(`DROP TYPE "virtual_nodes_status_enum"`);
    await queryRunner.query(`DROP TYPE "virtual_nodes_type_enum"`);
    await queryRunner.query(`DROP TYPE "storage_policies_type_enum"`);
  }
}
