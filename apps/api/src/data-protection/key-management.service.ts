import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DataProtectionException } from './data-protection-error';

export interface WrappedDataKey {
  encryptedDek: string;
  dekIv: string;
  dekAuthTag: string;
  keyVersion: number;
}

@Injectable()
export class KeyManagementService {
  constructor(private readonly config: ConfigService) {}

  getCurrentVersion(): number {
    const version = this.config.get<number>('dataProtection.keyVersion') ?? 1;
    if (!Number.isSafeInteger(version) || version < 1) throw new DataProtectionException('KEY_UNAVAILABLE');
    return version;
  }

  wrapDataKey(dataKey: Buffer, context: string): WrappedDataKey {
    try {
      if (dataKey.length !== 32) throw new Error('Invalid data key length');
      const keyVersion = this.getCurrentVersion();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.resolveKey(keyVersion), iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const encrypted = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      return {
        encryptedDek: encrypted.toString('base64'),
        dekIv: iv.toString('base64'),
        dekAuthTag: cipher.getAuthTag().toString('base64'),
        keyVersion,
      };
    } catch (error) {
      if (error instanceof DataProtectionException) throw error;
      throw new DataProtectionException('ENCRYPTION_FAILED');
    }
  }

  unwrapDataKey(metadata: WrappedDataKey, context: string): Buffer {
    if (!Number.isSafeInteger(metadata.keyVersion) || metadata.keyVersion < 1) {
      throw new DataProtectionException('KEY_VERSION_UNKNOWN');
    }
    let kek: Buffer;
    try {
      kek = this.resolveKey(metadata.keyVersion);
    } catch (error) {
      if (error instanceof DataProtectionException) throw error;
      throw new DataProtectionException('KEY_UNAVAILABLE');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(metadata.dekIv, 'base64'));
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(Buffer.from(metadata.dekAuthTag, 'base64'));
      const key = Buffer.concat([
        decipher.update(Buffer.from(metadata.encryptedDek, 'base64')),
        decipher.final(),
      ]);
      if (key.length !== 32) throw new Error('Invalid unwrapped data key length');
      return key;
    } catch {
      throw new DataProtectionException('DECRYPTION_FAILED');
    }
  }

  rewrapDataKey(metadata: WrappedDataKey, context: string): WrappedDataKey {
    const dataKey = this.unwrapDataKey(metadata, context);
    try {
      return this.wrapDataKey(dataKey, context);
    } finally {
      dataKey.fill(0);
    }
  }

  private resolveKey(version: number): Buffer {
    const ringValue = this.config.get<string>('dataProtection.masterKeysJson');
    if (ringValue?.trim()) {
      let ring: Record<string, string>;
      try {
        ring = JSON.parse(ringValue) as Record<string, string>;
      } catch {
        throw new DataProtectionException('KEY_UNAVAILABLE');
      }
      const configured = ring[String(version)];
      if (configured) return this.decodeKey(configured);
    }

    const currentVersion = this.getCurrentVersion();
    if (version !== currentVersion) throw new DataProtectionException('KEY_VERSION_UNKNOWN');
    const currentKey = this.config.get<string>('dataProtection.masterKey');
    if (!currentKey) throw new DataProtectionException('KEY_UNAVAILABLE');
    return this.decodeKey(currentKey);
  }

  private decodeKey(value: string): Buffer {
    let key: Buffer;
    if (/^[0-9a-fA-F]{64}$/.test(value)) {
      key = Buffer.from(value, 'hex');
    } else {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new DataProtectionException('KEY_UNAVAILABLE');
      }
      key = Buffer.from(value, 'base64');
      if (key.toString('base64') !== value) throw new DataProtectionException('KEY_UNAVAILABLE');
    }
    if (key.length !== 32) throw new DataProtectionException('KEY_UNAVAILABLE');
    return key;
  }
}
