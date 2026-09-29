import { MigrationInterface, QueryRunner } from 'typeorm';

export class DeviceRegistry1733000000000 implements MigrationInterface {
  name = 'DeviceRegistry1733000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "device_platform" AS ENUM ('WINDOWS', 'MACOS', 'LINUX', 'NAS')`);
    await queryRunner.query(`CREATE TABLE "user_devices" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "user_id" uuid NOT NULL,
      "installation_id" uuid NOT NULL,
      "name" character varying(128) NOT NULL,
      "platform" "device_platform" NOT NULL,
      "client_version" character varying(64),
      "peer_id" character varying(128),
      "peer_public_key" text,
      "refresh_token_hash" text,
      "p2p_enabled" boolean NOT NULL DEFAULT false,
      "lan_discovery_enabled" boolean NOT NULL DEFAULT true,
      "internet_p2p_enabled" boolean NOT NULL DEFAULT false,
      "relay_allowed" boolean NOT NULL DEFAULT true,
      "serve_local_files" boolean NOT NULL DEFAULT false,
      "storage_contribution_enabled" boolean NOT NULL DEFAULT false,
      "last_seen_at" TIMESTAMP WITH TIME ZONE,
      "revoked_at" TIMESTAMP WITH TIME ZONE,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_user_devices" PRIMARY KEY ("id"),
      CONSTRAINT "FK_user_devices_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
      CONSTRAINT "UQ_user_devices_user_installation" UNIQUE ("user_id", "installation_id")
    )`);
    await queryRunner.query(`CREATE INDEX "IDX_user_devices_user_revoked" ON "user_devices" ("user_id", "revoked_at")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_user_devices_peer_id" ON "user_devices" ("peer_id") WHERE "peer_id" IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_user_devices_peer_id"`);
    await queryRunner.query(`DROP INDEX "IDX_user_devices_user_revoked"`);
    await queryRunner.query(`DROP TABLE "user_devices"`);
    await queryRunner.query(`DROP TYPE "device_platform"`);
  }
}
