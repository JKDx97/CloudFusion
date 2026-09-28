import { MigrationInterface, QueryRunner } from 'typeorm';

export class StorageRules1713000000000 implements MigrationInterface {
  name = 'StorageRules1713000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "storage_rules_condition_type_enum" AS ENUM ('EXTENSION', 'MIME', 'SIZE_GREATER_THAN', 'DEFAULT')`);
    await queryRunner.query(`
      CREATE TABLE "storage_rules" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "name" character varying(120) NOT NULL,
        "priority" integer NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "condition_type" "storage_rules_condition_type_enum" NOT NULL,
        "condition_value" character varying(255),
        "destination_account_id" uuid NOT NULL,
        "destination_folder_id" character varying(1024),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_rules_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_storage_rules_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_storage_rules_user_priority" ON "storage_rules" ("user_id", "priority")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_storage_rules_user_priority"`);
    await queryRunner.query(`DROP TABLE "storage_rules"`);
    await queryRunner.query(`DROP TYPE "storage_rules_condition_type_enum"`);
  }
}
