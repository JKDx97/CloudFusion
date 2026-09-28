import { HttpException, HttpStatus } from '@nestjs/common';

export type DataProtectionErrorCode =
  | 'ENCRYPTION_FAILED'
  | 'DECRYPTION_FAILED'
  | 'KEY_UNAVAILABLE'
  | 'KEY_VERSION_UNKNOWN'
  | 'INTEGRITY_CHECK_FAILED'
  | 'CORRUPTED_ENCRYPTED_OBJECT';

const publicMessages: Record<DataProtectionErrorCode, string> = {
  ENCRYPTION_FAILED: 'The file could not be encrypted',
  DECRYPTION_FAILED: 'The protected file could not be decrypted',
  KEY_UNAVAILABLE: 'Encryption key material is unavailable',
  KEY_VERSION_UNKNOWN: 'The file uses an unsupported encryption key version',
  INTEGRITY_CHECK_FAILED: 'The protected file failed its integrity check',
  CORRUPTED_ENCRYPTED_OBJECT: 'The protected file is corrupted',
};

export class DataProtectionException extends HttpException {
  readonly code: DataProtectionErrorCode;

  constructor(code: DataProtectionErrorCode) {
    const status = code === 'KEY_UNAVAILABLE' || code === 'KEY_VERSION_UNKNOWN'
      ? HttpStatus.SERVICE_UNAVAILABLE
      : code === 'ENCRYPTION_FAILED'
        ? HttpStatus.INTERNAL_SERVER_ERROR
        : HttpStatus.UNPROCESSABLE_ENTITY;
    super({ code, message: publicMessages[code], error: code }, status);
    this.code = code;
  }
}
