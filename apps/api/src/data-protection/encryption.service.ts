import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DataProtectionException } from './data-protection-error';
import { KeyManagementService, WrappedDataKey } from './key-management.service';

export interface EncryptedFileMetadata extends WrappedDataKey {
  encryptionAlgorithm: 'AES-256-GCM';
  contentIv: string;
  contentAuthTag: string;
  checksum: string;
  encryptedChecksum: string;
  logicalSize: number;
  encryptedSize: number;
}

export interface DecryptionMetadata extends EncryptedFileMetadata {}

function hashingTransform(hash: ReturnType<typeof createHash>): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

@Injectable()
export class EncryptionService {
  constructor(private readonly keys: KeyManagementService) {}

  async encryptFile(inputPath: string, outputPath: string, context: string): Promise<EncryptedFileMetadata> {
    const dataKey = randomBytes(32);
    const contentIv = randomBytes(12);
    let wrapped: WrappedDataKey;
    try {
      wrapped = this.keys.wrapDataKey(dataKey, context);
      const cipher = createCipheriv('aes-256-gcm', dataKey, contentIv);
      const logicalHash = createHash('sha256');
      const encryptedHash = createHash('sha256');
      let logicalSize = 0;
      const countAndHash = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          logicalSize += chunk.length;
          logicalHash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        createReadStream(inputPath),
        countAndHash,
        cipher,
        hashingTransform(encryptedHash),
        createWriteStream(outputPath, { flags: 'wx' }),
      );
      return {
        ...wrapped,
        encryptionAlgorithm: 'AES-256-GCM',
        contentIv: contentIv.toString('base64'),
        contentAuthTag: cipher.getAuthTag().toString('base64'),
        checksum: logicalHash.digest('hex'),
        encryptedChecksum: encryptedHash.digest('hex'),
        logicalSize,
        encryptedSize: logicalSize,
      };
    } catch (error) {
      await unlink(outputPath).catch(() => undefined);
      if (error instanceof DataProtectionException) throw error;
      throw new DataProtectionException('ENCRYPTION_FAILED');
    } finally {
      dataKey.fill(0);
    }
  }

  async decryptFile(
    encryptedStream: NodeJS.ReadableStream,
    outputPath: string,
    context: string,
    metadata: DecryptionMetadata,
  ): Promise<{ checksum: string; size: number }> {
    if (metadata.encryptionAlgorithm !== 'AES-256-GCM') {
      throw new DataProtectionException('CORRUPTED_ENCRYPTED_OBJECT');
    }
    const dataKey = this.keys.unwrapDataKey(metadata, context);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      dataKey,
      Buffer.from(metadata.contentIv, 'base64'),
    );
    const logicalHash = createHash('sha256');
    const encryptedHash = createHash('sha256');
    let logicalSize = 0;
    const countLogical = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        logicalSize += chunk.length;
        logicalHash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      decipher.setAuthTag(Buffer.from(metadata.contentAuthTag, 'base64'));
      await pipeline(
        encryptedStream as import('node:stream').Readable,
        hashingTransform(encryptedHash),
        decipher,
        countLogical,
        createWriteStream(outputPath, { flags: 'wx' }),
      );
      const checksum = logicalHash.digest('hex');
      const cipherChecksum = encryptedHash.digest('hex');
      if (
        checksum !== metadata.checksum ||
        cipherChecksum !== metadata.encryptedChecksum ||
        logicalSize !== metadata.logicalSize
      ) {
        throw new DataProtectionException('INTEGRITY_CHECK_FAILED');
      }
      return { checksum, size: logicalSize };
    } catch (error) {
      await unlink(outputPath).catch(() => undefined);
      if (error instanceof DataProtectionException) throw error;
      throw new DataProtectionException('DECRYPTION_FAILED');
    } finally {
      dataKey.fill(0);
    }
  }
}
