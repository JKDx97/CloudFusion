import { MigrationInterface, QueryRunner } from 'typeorm';

export class PeerTransferCoordination1734000000000 implements MigrationInterface {
  name = 'PeerTransferCoordination1734000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "peer_transfer_status" AS ENUM (
      'AUTHORIZED', 'CLAIMED', 'TRANSFERRING', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'
    )`);
    await queryRunner.query(`CREATE TYPE "peer_transfer_transport" AS ENUM (
      'LAN_DIRECT', 'P2P_DIRECT', 'P2P_RELAY', 'CLOUD_FALLBACK'
    )`);
    await queryRunner.query(`CREATE TABLE "device_file_availability" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "user_id" uuid NOT NULL,
      "device_id" uuid NOT NULL,
      "node_id" uuid NOT NULL,
      "version_id" uuid NOT NULL,
      "content_hash" character varying(128) NOT NULL,
      "size_bytes" bigint NOT NULL,
      "status" character varying(16) NOT NULL DEFAULT 'AVAILABLE',
      "last_verified_at" TIMESTAMP WITH TIME ZONE NOT NULL,
      "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_device_file_availability" PRIMARY KEY ("id"),
      CONSTRAINT "CK_device_file_availability_size" CHECK ("size_bytes" >= 0),
      CONSTRAINT "CK_device_file_availability_status" CHECK ("status" IN ('AVAILABLE', 'OFFLINE', 'CORRUPTED')),
      CONSTRAINT "UQ_device_file_availability_device_version" UNIQUE ("device_id", "node_id", "version_id"),
      CONSTRAINT "FK_device_file_availability_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
      CONSTRAINT "FK_device_file_availability_device" FOREIGN KEY ("device_id") REFERENCES "user_devices"("id") ON DELETE CASCADE,
      CONSTRAINT "FK_device_file_availability_node" FOREIGN KEY ("node_id") REFERENCES "virtual_nodes"("id") ON DELETE CASCADE,
      CONSTRAINT "FK_device_file_availability_version" FOREIGN KEY ("version_id") REFERENCES "file_versions"("id") ON DELETE CASCADE
    )`);
    await queryRunner.query(`CREATE INDEX "IDX_device_file_availability_version_expiry" ON "device_file_availability" ("node_id", "version_id", "expires_at")`);

    await queryRunner.query(`CREATE TABLE "peer_transfer_sessions" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "source_user_id" uuid NOT NULL,
      "destination_user_id" uuid NOT NULL,
      "source_device_id" uuid NOT NULL,
      "destination_device_id" uuid NOT NULL,
      "node_id" uuid NOT NULL,
      "version_id" uuid NOT NULL,
      "content_hash" character varying(128) NOT NULL,
      "total_bytes" bigint NOT NULL,
      "status" "peer_transfer_status" NOT NULL DEFAULT 'AUTHORIZED',
      "transport" "peer_transfer_transport",
      "bytes_transferred" bigint NOT NULL DEFAULT 0,
      "ticket_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
      "started_at" TIMESTAMP WITH TIME ZONE,
      "completed_at" TIMESTAMP WITH TIME ZONE,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_peer_transfer_sessions" PRIMARY KEY ("id"),
      CONSTRAINT "CK_peer_transfer_total_bytes" CHECK ("total_bytes" >= 0),
      CONSTRAINT "CK_peer_transfer_bytes_transferred" CHECK ("bytes_transferred" >= 0 AND "bytes_transferred" <= "total_bytes"),
      CONSTRAINT "FK_peer_transfer_source_user" FOREIGN KEY ("source_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
      CONSTRAINT "FK_peer_transfer_destination_user" FOREIGN KEY ("destination_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
      CONSTRAINT "FK_peer_transfer_source_device" FOREIGN KEY ("source_device_id") REFERENCES "user_devices"("id") ON DELETE CASCADE,
      CONSTRAINT "FK_peer_transfer_destination_device" FOREIGN KEY ("destination_device_id") REFERENCES "user_devices"("id") ON DELETE CASCADE,
      CONSTRAINT "FK_peer_transfer_node" FOREIGN KEY ("node_id") REFERENCES "virtual_nodes"("id") ON DELETE CASCADE,
      CONSTRAINT "FK_peer_transfer_version" FOREIGN KEY ("version_id") REFERENCES "file_versions"("id") ON DELETE CASCADE
    )`);
    await queryRunner.query(`CREATE INDEX "IDX_peer_transfers_source_status" ON "peer_transfer_sessions" ("source_device_id", "status", "created_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_peer_transfers_destination_status" ON "peer_transfer_sessions" ("destination_device_id", "status", "created_at")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_peer_transfers_destination_status"`);
    await queryRunner.query(`DROP INDEX "IDX_peer_transfers_source_status"`);
    await queryRunner.query(`DROP TABLE "peer_transfer_sessions"`);
    await queryRunner.query(`DROP INDEX "IDX_device_file_availability_version_expiry"`);
    await queryRunner.query(`DROP TABLE "device_file_availability"`);
    await queryRunner.query(`DROP TYPE "peer_transfer_transport"`);
    await queryRunner.query(`DROP TYPE "peer_transfer_status"`);
  }
}
