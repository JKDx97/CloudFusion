import { MigrationInterface, QueryRunner } from 'typeorm';

export class WorkspaceDrive1731000000000 implements MigrationInterface {
  name = 'WorkspaceDrive1731000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "virtual_nodes" ADD "workspace_id" uuid');
    await queryRunner.query('ALTER TABLE "virtual_nodes" ADD CONSTRAINT "FK_virtual_nodes_workspace" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT');
    await queryRunner.query('CREATE INDEX "IDX_virtual_nodes_workspace_parent" ON "virtual_nodes" ("workspace_id", "parent_id")');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_virtual_nodes_workspace_root" ON "virtual_nodes" ("workspace_id") WHERE "workspace_id" IS NOT NULL AND "is_root" = true AND "deleted_at" IS NULL');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."UQ_virtual_nodes_workspace_root"');
    await queryRunner.query('DROP INDEX "public"."IDX_virtual_nodes_workspace_parent"');
    await queryRunner.query('ALTER TABLE "virtual_nodes" DROP CONSTRAINT "FK_virtual_nodes_workspace"');
    await queryRunner.query('ALTER TABLE "virtual_nodes" DROP COLUMN "workspace_id"');
  }
}
