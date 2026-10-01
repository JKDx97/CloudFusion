import { MigrationInterface, QueryRunner } from 'typeorm';

export class DeviceStorageTargets1736000000000 implements MigrationInterface {
  name = 'DeviceStorageTargets1736000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "storage_targets" ALTER COLUMN "cloud_account_id" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "storage_targets" ALTER COLUMN "remote_identifier" DROP NOT NULL`);
    await queryRunner.query(`
      ALTER TABLE "storage_targets"
      ADD COLUMN "device_id" uuid,
      ADD COLUMN "max_bytes" bigint,
      ADD COLUMN "used_bytes" bigint NOT NULL DEFAULT 0,
      ADD COLUMN "available_bytes" bigint NOT NULL DEFAULT 0,
      ADD COLUMN "storage_class" character varying(32),
      ADD COLUMN "availability_status" character varying(16),
      ADD COLUMN "last_seen_at" TIMESTAMP WITH TIME ZONE,
      ADD CONSTRAINT "FK_storage_targets_device" FOREIGN KEY ("device_id") REFERENCES "user_devices"("id") ON DELETE CASCADE,
      ADD CONSTRAINT "CHK_storage_targets_owner" CHECK (
        ("type" = 'DEVICE' AND "device_id" IS NOT NULL AND "cloud_account_id" IS NULL AND "remote_identifier" IS NULL)
        OR
        ("type" <> 'DEVICE' AND "device_id" IS NULL AND "cloud_account_id" IS NOT NULL AND "remote_identifier" IS NOT NULL)
      ),
      ADD CONSTRAINT "CHK_storage_targets_device_capacity" CHECK (
        "type" <> 'DEVICE' OR (
          "max_bytes" > 0 AND "used_bytes" >= 0 AND "available_bytes" >= 0
          AND "used_bytes" <= "max_bytes" AND "available_bytes" = "max_bytes" - "used_bytes"
        )
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_storage_targets_device" ON "storage_targets" ("device_id") WHERE "type" = 'DEVICE' AND "device_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_storage_targets_device_status" ON "storage_targets" ("device_id", "availability_status")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`SELECT EXISTS (SELECT 1 FROM "storage_targets" WHERE "type" = 'DEVICE') AS "exists"`)) as Array<{ exists: boolean }>;
    if (rows[0]?.exists) throw new Error('Cannot revert device storage targets while devices have contributed storage');

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_storage_targets_device_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_storage_targets_device"`);
    await queryRunner.query(`ALTER TABLE "storage_targets" DROP CONSTRAINT IF EXISTS "CHK_storage_targets_device_capacity"`);
    await queryRunner.query(`ALTER TABLE "storage_targets" DROP CONSTRAINT IF EXISTS "CHK_storage_targets_owner"`);
    await queryRunner.query(`ALTER TABLE "storage_targets" DROP CONSTRAINT IF EXISTS "FK_storage_targets_device"`);
    await queryRunner.query(`
      ALTER TABLE "storage_targets"
      DROP COLUMN "last_seen_at",
      DROP COLUMN "availability_status",
      DROP COLUMN "storage_class",
      DROP COLUMN "available_bytes",
      DROP COLUMN "used_bytes",
      DROP COLUMN "max_bytes",
      DROP COLUMN "device_id"
    `);
    await queryRunner.query(`ALTER TABLE "storage_targets" ALTER COLUMN "remote_identifier" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "storage_targets" ALTER COLUMN "cloud_account_id" SET NOT NULL`);
  }
}
