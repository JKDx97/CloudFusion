import { MigrationInterface, QueryRunner } from 'typeorm';

export class DeviceStorageReplicas1737000000000 implements MigrationInterface {
  name = 'DeviceStorageReplicas1737000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "device_storage_replicas" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "device_id" uuid NOT NULL,
        "node_id" uuid NOT NULL,
        "version_id" uuid NOT NULL,
        "storage_object_id" uuid NOT NULL,
        "content_hash" character varying(128) NOT NULL,
        "size_bytes" bigint NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'PENDING',
        "attempts" integer NOT NULL DEFAULT 0,
        "lease_expires_at" TIMESTAMP WITH TIME ZONE,
        "last_verified_at" TIMESTAMP WITH TIME ZONE,
        "last_error" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_device_storage_replicas_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_device_storage_replica_device_version" UNIQUE ("device_id", "node_id", "version_id"),
        CONSTRAINT "FK_device_storage_replica_device" FOREIGN KEY ("device_id") REFERENCES "user_devices"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_device_storage_replica_size" CHECK ("size_bytes" >= 0),
        CONSTRAINT "CHK_device_storage_replica_attempts" CHECK ("attempts" >= 0),
        CONSTRAINT "CHK_device_storage_replica_status" CHECK ("status" IN ('PENDING', 'DOWNLOADING', 'AVAILABLE', 'OFFLINE', 'CORRUPTED', 'CANCELLED')),
        CONSTRAINT "CHK_device_storage_replica_hash" CHECK ("content_hash" ~ '^[A-Fa-f0-9]{64}$')
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_device_storage_replicas_device_status" ON "device_storage_replicas" ("device_id", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_device_storage_replicas_object_status" ON "device_storage_replicas" ("storage_object_id", "status")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`SELECT EXISTS (SELECT 1 FROM "device_storage_replicas" WHERE "status" = 'AVAILABLE') AS "exists"`)) as Array<{ exists: boolean }>;
    if (rows[0]?.exists) throw new Error('Cannot revert while device replicas are stored on user devices');
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_device_storage_replicas_object_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_device_storage_replicas_device_status"`);
    await queryRunner.query(`DROP TABLE "device_storage_replicas"`);
  }
}
