import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

@Injectable()
export class TokenEncryptionService {
  constructor(private readonly config: ConfigService) {}

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const [version, ivValue, tagValue, ciphertextValue] = payload.split('.');
    if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) {
      throw new BadRequestException('Invalid encrypted token');
    }
    try {
      const iv = this.decodeBase64Url(ivValue);
      const tag = this.decodeBase64Url(tagValue);
      const ciphertext = this.decodeBase64Url(ciphertextValue);
      const decipher = createDecipheriv('aes-256-gcm', this.getKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new BadRequestException('Invalid encrypted token');
    }
  }

  private getKey(): Buffer {
    const configured = this.config.get<string>('cloud.tokenEncryptionKey');
    if (!configured) throw new Error('CLOUD_TOKEN_ENCRYPTION_KEY is not configured');
    if (/^[0-9a-f]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
    const key = Buffer.from(configured, 'base64');
    if (key.length !== 32) throw new Error('CLOUD_TOKEN_ENCRYPTION_KEY must encode 32 bytes');
    return key;
  }

  private decodeBase64Url(value: string): Buffer {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('Non-canonical base64url');
    return decoded;
  }
}
