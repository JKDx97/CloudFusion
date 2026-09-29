import { MigrationInterface, QueryRunner } from 'typeorm';

export class WorkspaceInvitations1730000000000 implements MigrationInterface {
  name = 'WorkspaceInvitations1730000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "workspace_invitations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "workspace_id" uuid NOT NULL,
        "inviter_user_id" uuid NOT NULL,
        "email" character varying(255) NOT NULL,
        "role" "workspace_members_role_enum" NOT NULL,
        "token_hash" character(64) NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "accepted_at" TIMESTAMP WITH TIME ZONE,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_workspace_invitations_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_workspace_invitations_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "FK_workspace_invitations_workspace" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_workspace_invitations_inviter" FOREIGN KEY ("inviter_user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_workspace_invitations_workspace_created" ON "workspace_invitations" ("workspace_id", "created_at")');
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_workspace_invitations_pending_email" ON "workspace_invitations" ("workspace_id", "email") WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."UQ_workspace_invitations_pending_email"');
    await queryRunner.query('DROP INDEX "public"."IDX_workspace_invitations_workspace_created"');
    await queryRunner.query('DROP TABLE "workspace_invitations"');
  }
}
