import { MigrationInterface, QueryRunner } from 'typeorm';

export class DevicePairingCodes1735000000000 implements MigrationInterface {
  name = 'DevicePairingCodes1735000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "device_pairing_codes" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "user_id" uuid NOT NULL,
      "code_hash" character varying(64) NOT NULL,
      "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
      "consumed_at" TIMESTAMP WITH TIME ZONE,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_device_pairing_codes" PRIMARY KEY ("id"),
      CONSTRAINT "FK_device_pairing_codes_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_device_pairing_codes_hash" ON "device_pairing_codes" ("code_hash")`);
    await queryRunner.query(`CREATE INDEX "IDX_device_pairing_codes_expiry" ON "device_pairing_codes" ("expires_at")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_device_pairing_codes_expiry"`);
    await queryRunner.query(`DROP INDEX "IDX_device_pairing_codes_hash"`);
    await queryRunner.query(`DROP TABLE "device_pairing_codes"`);
  }
}
