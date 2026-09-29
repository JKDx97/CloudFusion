import { MigrationInterface, QueryRunner } from 'typeorm';

export class PublicShares1728000000000 implements MigrationInterface {
  name = 'PublicShares1728000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public_shares_permission_enum" AS ENUM ('VIEW_ONLY', 'DOWNLOAD')`);
    await queryRunner.query(`
      CREATE TABLE "public_shares" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_user_id" uuid NOT NULL,
        "node_id" uuid NOT NULL,
        "token_hash" character(64) NOT NULL,
        "permission" "public_shares_permission_enum" NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "password_hash" text,
        "download_limit" integer,
        "download_count" integer NOT NULL DEFAULT 0,
        "enabled" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_public_shares_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_public_shares_owner" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_public_shares_node" FOREIGN KEY ("node_id") REFERENCES "virtual_nodes"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_public_shares_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "CK_public_shares_download_count" CHECK ("download_count" >= 0),
        CONSTRAINT "CK_public_shares_download_limit" CHECK ("download_limit" IS NULL OR "download_limit" > 0)
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_public_shares_owner_created" ON "public_shares" ("owner_user_id", "created_at")');
    await queryRunner.query('CREATE INDEX "IDX_public_shares_node_enabled" ON "public_shares" ("node_id", "enabled")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."IDX_public_shares_node_enabled"');
    await queryRunner.query('DROP INDEX "public"."IDX_public_shares_owner_created"');
    await queryRunner.query('DROP TABLE "public_shares"');
    await queryRunner.query('DROP TYPE "public_shares_permission_enum"');
  }
}
