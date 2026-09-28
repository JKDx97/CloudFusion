import { HttpException, HttpStatus } from '@nestjs/common';

export enum ProviderErrorCode {
  PROVIDER_AUTH_EXPIRED = 'PROVIDER_AUTH_EXPIRED',
  PROVIDER_RATE_LIMITED = 'PROVIDER_RATE_LIMITED',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND',
  ACCOUNT_NOT_CONNECTED = 'ACCOUNT_NOT_CONNECTED',
  INSUFFICIENT_STORAGE = 'INSUFFICIENT_STORAGE',
  UPLOAD_FAILED = 'UPLOAD_FAILED',
  DOWNLOAD_FAILED = 'DOWNLOAD_FAILED',
  MOVE_SOURCE_DELETE_FAILED = 'MOVE_SOURCE_DELETE_FAILED',
  NO_SUITABLE_STORAGE_PROVIDER = 'NO_SUITABLE_STORAGE_PROVIDER',
  TRANSFER_CANCELLED = 'TRANSFER_CANCELLED',
}

export class ProviderException extends HttpException {
  constructor(code: ProviderErrorCode, status = HttpStatus.BAD_GATEWAY) {
    super({ code, message: code }, status);
  }
}

export function providerHttpError(error: unknown, fallback: ProviderErrorCode): ProviderException {
  const status = getStatus(error);
  if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) {
    return new ProviderException(ProviderErrorCode.PROVIDER_AUTH_EXPIRED, HttpStatus.UNAUTHORIZED);
  }
  if (status === HttpStatus.NOT_FOUND) {
    return new ProviderException(ProviderErrorCode.FILE_NOT_FOUND, HttpStatus.NOT_FOUND);
  }
  if (status === HttpStatus.TOO_MANY_REQUESTS) {
    return new ProviderException(ProviderErrorCode.PROVIDER_RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS);
  }
  return new ProviderException(fallback, HttpStatus.BAD_GATEWAY);
}

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { response?: { status?: number }; status?: number };
  return value.response?.status ?? value.status;
}
