import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShareInvitations1727000000000 implements MigrationInterface {
  name = 'ShareInvitations1727000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "share_invitations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" character varying(255) NOT NULL,
        "node_id" uuid NOT NULL,
        "owner_user_id" uuid NOT NULL,
        "role" "resource_shares_role_enum" NOT NULL,
        "token_hash" character(64) NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "accepted_at" TIMESTAMP WITH TIME ZONE,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_share_invitations_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_share_invitations_node" FOREIGN KEY ("node_id") REFERENCES "virtual_nodes"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_share_invitations_owner" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_share_invitations_token_hash" UNIQUE ("token_hash")
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_share_invitations_owner_created" ON "share_invitations" ("owner_user_id", "created_at")');
    await queryRunner.query('CREATE INDEX "IDX_share_invitations_email_expiry" ON "share_invitations" ("email", "expires_at")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."IDX_share_invitations_email_expiry"');
    await queryRunner.query('DROP INDEX "public"."IDX_share_invitations_owner_created"');
    await queryRunner.query('DROP TABLE "share_invitations"');
  }
}
