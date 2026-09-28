import { BadRequestException } from '@nestjs/common';
import { TokenEncryptionService } from './token-encryption.service';

describe('TokenEncryptionService', () => {
  const config = {
    get: jest.fn().mockReturnValue('MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='),
  };
  const service = new TokenEncryptionService(config as never);

  it('encrypts and decrypts provider tokens without returning plaintext', () => {
    const encrypted = service.encrypt('provider-refresh-token');

    expect(encrypted).not.toContain('provider-refresh-token');
    expect(service.decrypt(encrypted)).toBe('provider-refresh-token');
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = service.encrypt('provider-access-token');
    const tampered = `${encrypted.slice(0, -1)}x`;

    expect(() => service.decrypt(tampered)).toThrow(BadRequestException);
  });
});
