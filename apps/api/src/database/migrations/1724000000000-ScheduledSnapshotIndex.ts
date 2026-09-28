import { MigrationInterface, QueryRunner } from 'typeorm';

export class ScheduledSnapshotIndex1724000000000 implements MigrationInterface {
  name = 'ScheduledSnapshotIndex1724000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_snapshots_scheduled_daily" ON "snapshots" ("user_id", "description") WHERE "description" LIKE 'scheduled:daily:%'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."UQ_snapshots_scheduled_daily"');
  }
}
