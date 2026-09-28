import { MigrationInterface, QueryRunner } from 'typeorm';

export class StorageObjectReferenceCounts1718000000000 implements MigrationInterface {
  name = 'StorageObjectReferenceCounts1718000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "storage_objects" AS object
      SET "reference_count" = (
        SELECT COUNT(*)::integer
        FROM "virtual_nodes" AS node
        WHERE node."storage_object_id" = object."id"
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('UPDATE "storage_objects" SET "reference_count" = 1');
  }
}
