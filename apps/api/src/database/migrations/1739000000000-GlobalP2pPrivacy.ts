import { MigrationInterface, QueryRunner } from 'typeorm';

export class GlobalP2pPrivacy1739000000000 implements MigrationInterface {
  name = 'GlobalP2pPrivacy1739000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN "p2p_enabled" boolean NOT NULL DEFAULT TRUE
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "p2p_enabled"`);
  }
}
