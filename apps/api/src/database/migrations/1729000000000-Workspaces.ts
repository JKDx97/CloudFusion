import { MigrationInterface, QueryRunner } from 'typeorm';

export class Workspaces1729000000000 implements MigrationInterface {
  name = 'Workspaces1729000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "workspace_members_role_enum" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER')`);
    await queryRunner.query(`
      CREATE TABLE "workspaces" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(100) NOT NULL,
        "slug" character varying(100) NOT NULL,
        "description" text,
        "owner_user_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_workspaces_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_workspaces_slug" UNIQUE ("slug"),
        CONSTRAINT "FK_workspaces_owner" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "workspace_members" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "workspace_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "role" "workspace_members_role_enum" NOT NULL,
        "joined_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_workspace_members_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_workspace_members_workspace_user" UNIQUE ("workspace_id", "user_id"),
        CONSTRAINT "FK_workspace_members_workspace" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_workspace_members_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_workspace_members_single_owner" ON "workspace_members" ("workspace_id") WHERE "role" = 'OWNER'`);
    await queryRunner.query('CREATE INDEX "IDX_workspaces_owner_created" ON "workspaces" ("owner_user_id", "created_at")');
    await queryRunner.query('CREATE INDEX "IDX_workspace_members_user_joined" ON "workspace_members" ("user_id", "joined_at")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."IDX_workspace_members_user_joined"');
    await queryRunner.query('DROP INDEX "public"."IDX_workspaces_owner_created"');
    await queryRunner.query('DROP INDEX "public"."UQ_workspace_members_single_owner"');
    await queryRunner.query('DROP TABLE "workspace_members"');
    await queryRunner.query('DROP TABLE "workspaces"');
    await queryRunner.query('DROP TYPE "workspace_members_role_enum"');
  }
}
