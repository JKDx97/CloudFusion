import { MigrationInterface, QueryRunner } from 'typeorm';

export class VirtualDriveRoot1716000000000 implements MigrationInterface {
  name = 'VirtualDriveRoot1716000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_virtual_nodes_user_root" ON "virtual_nodes" ("user_id") WHERE "is_root" = true`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_virtual_nodes_user_root"`);
  }
}
