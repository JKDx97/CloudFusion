import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1710000000000 implements MigrationInterface {
  name = 'InitialSchema1710000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await queryRunner.query(
      "CREATE TYPE \"users_role_enum\" AS ENUM ('USER', 'ADMIN')",
    );
    await queryRunner.query(
      "CREATE TYPE \"users_status_enum\" AS ENUM ('ACTIVE', 'DISABLED')",
    );
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" varchar(255) NOT NULL,
        "username" varchar(32) NOT NULL,
        "password_hash" text NOT NULL,
        "role" "users_role_enum" NOT NULL DEFAULT 'USER',
        "status" "users_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "refresh_token_hash" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email"),
        CONSTRAINT "UQ_users_username" UNIQUE ("username")
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_users_email" ON "users" ("email")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_users_username" ON "users" ("username")',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."IDX_users_username"');
    await queryRunner.query('DROP INDEX "public"."IDX_users_email"');
    await queryRunner.query('DROP TABLE "users"');
    await queryRunner.query('DROP TYPE "users_status_enum"');
    await queryRunner.query('DROP TYPE "users_role_enum"');
  }
}
