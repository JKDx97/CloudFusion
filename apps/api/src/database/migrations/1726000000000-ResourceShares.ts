import { MigrationInterface, QueryRunner } from 'typeorm';

export class ResourceShares1726000000000 implements MigrationInterface {
  name = 'ResourceShares1726000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "resource_shares_role_enum" AS ENUM ('VIEWER', 'EDITOR')`);
    await queryRunner.query(`CREATE TYPE "resource_shares_status_enum" AS ENUM ('ACTIVE', 'REVOKED')`);
    await queryRunner.query(`
      CREATE TABLE "resource_shares" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_user_id" uuid NOT NULL,
        "node_id" uuid NOT NULL,
        "shared_with_user_id" uuid NOT NULL,
        "role" "resource_shares_role_enum" NOT NULL,
        "status" "resource_shares_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_resource_shares_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_resource_shares_owner" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_resource_shares_recipient" FOREIGN KEY ("shared_with_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_resource_shares_node" FOREIGN KEY ("node_id") REFERENCES "virtual_nodes"("id") ON DELETE CASCADE,
        CONSTRAINT "CK_resource_shares_not_self" CHECK ("owner_user_id" <> "shared_with_user_id"),
        CONSTRAINT "UQ_resource_shares_node_recipient" UNIQUE ("node_id", "shared_with_user_id")
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_resource_shares_owner" ON "resource_shares" ("owner_user_id", "created_at")');
    await queryRunner.query('CREATE INDEX "IDX_resource_shares_recipient" ON "resource_shares" ("shared_with_user_id", "status", "created_at")');
    await queryRunner.query('CREATE INDEX "IDX_resource_shares_node_status" ON "resource_shares" ("node_id", "status")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."IDX_resource_shares_node_status"');
    await queryRunner.query('DROP INDEX "public"."IDX_resource_shares_recipient"');
    await queryRunner.query('DROP INDEX "public"."IDX_resource_shares_owner"');
    await queryRunner.query('DROP TABLE "resource_shares"');
    await queryRunner.query('DROP TYPE "resource_shares_status_enum"');
    await queryRunner.query('DROP TYPE "resource_shares_role_enum"');
  }
}
