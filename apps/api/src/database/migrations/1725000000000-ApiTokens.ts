import { MigrationInterface, QueryRunner } from 'typeorm';

export class ApiTokens1725000000000 implements MigrationInterface {
  name = 'ApiTokens1725000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "api_tokens" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "name" character varying(80) NOT NULL,
        "token_hash" character(64) NOT NULL,
        "prefix" character varying(24) NOT NULL,
        "scopes" text array NOT NULL DEFAULT '{}',
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "last_used_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_api_tokens_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_api_tokens_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_api_tokens_prefix" ON "api_tokens" ("prefix")');
    await queryRunner.query('CREATE INDEX "IDX_api_tokens_user_created" ON "api_tokens" ("user_id", "created_at")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."IDX_api_tokens_user_created"');
    await queryRunner.query('DROP INDEX "public"."UQ_api_tokens_prefix"');
    await queryRunner.query('DROP TABLE "api_tokens"');
  }
}
