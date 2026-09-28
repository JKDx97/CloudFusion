import { MigrationInterface, QueryRunner } from 'typeorm';

export class DataProtectionMetadata1717000000000 implements MigrationInterface {
  name = 'DataProtectionMetadata1717000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "storage_objects"
        ADD COLUMN "encrypted_checksum" character varying(128),
        ADD COLUMN "encrypted_size" bigint,
        ADD COLUMN "encryption_algorithm" character varying(32),
        ADD COLUMN "encrypted_dek" text,
        ADD COLUMN "dek_iv" character varying(64),
        ADD COLUMN "dek_auth_tag" character varying(64),
        ADD COLUMN "content_iv" character varying(64),
        ADD COLUMN "content_auth_tag" character varying(64),
        ADD COLUMN "key_version" integer,
        ADD COLUMN "reference_count" integer NOT NULL DEFAULT 1,
        ADD COLUMN "lifecycle_status" character varying(24) NOT NULL DEFAULT 'ACTIVE',
        ADD COLUMN "gc_after" TIMESTAMP WITH TIME ZONE,
        ADD CONSTRAINT "CHK_storage_objects_reference_count" CHECK ("reference_count" >= 0),
        ADD CONSTRAINT "CHK_storage_objects_lifecycle_status" CHECK ("lifecycle_status" IN ('ACTIVE', 'ORPHANED', 'GC_PENDING', 'DELETING', 'DELETED', 'ERROR'))
    `);
    await queryRunner.query(`CREATE INDEX "IDX_storage_objects_user_checksum" ON "storage_objects" ("user_id", "checksum", "size")`);
    await queryRunner.query(`CREATE INDEX "IDX_storage_objects_gc" ON "storage_objects" ("lifecycle_status", "gc_after")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_storage_objects_gc"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_storage_objects_user_checksum"`);
    await queryRunner.query(`ALTER TABLE "storage_objects" DROP CONSTRAINT "CHK_storage_objects_lifecycle_status", DROP CONSTRAINT "CHK_storage_objects_reference_count", DROP COLUMN "gc_after", DROP COLUMN "lifecycle_status", DROP COLUMN "reference_count", DROP COLUMN "key_version", DROP COLUMN "content_auth_tag", DROP COLUMN "content_iv", DROP COLUMN "dek_auth_tag", DROP COLUMN "dek_iv", DROP COLUMN "encrypted_dek", DROP COLUMN "encryption_algorithm", DROP COLUMN "encrypted_size", DROP COLUMN "encrypted_checksum"`);
  }
}
