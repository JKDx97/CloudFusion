import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { BackupVerificationService } from './backup-verification.service';
import { BackupCopy } from './entities/backup-copy.entity';

describe('BackupVerificationService', () => {
  it('verifies an encrypted backup copy incrementally by size and SHA-256', async () => {
    const bytes = Buffer.from('ciphertext-stream');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const accounts = { getAuthorizedAccount: jest.fn().mockResolvedValue({
      account: { id: 'destination-1' },
      adapter: { downloadFile: jest.fn().mockResolvedValue({ stream: Readable.from([bytes]) }) },
      accessToken: 'test-token',
    }) };
    const service = new BackupVerificationService(accounts as never);
    const result = await service.verify('user-1', { destinationAccountId: 'destination-1', remoteFileId: 'remote-1', size: String(bytes.length), encryptedChecksum: checksum } as BackupCopy);
    expect(result).toEqual({ bytes: bytes.length, checksum });
    expect(accounts.getAuthorizedAccount).toHaveBeenCalledWith('user-1', 'destination-1');
  });

  it('rejects a backup whose downloaded bytes do not match the expected encrypted checksum', async () => {
    const accounts = { getAuthorizedAccount: jest.fn().mockResolvedValue({
      account: { id: 'destination-1' },
      adapter: { downloadFile: jest.fn().mockResolvedValue({ stream: Readable.from([Buffer.from('changed')]) }) },
      accessToken: 'test-token',
    }) };
    const service = new BackupVerificationService(accounts as never);
    await expect(service.verify('user-1', { destinationAccountId: 'destination-1', remoteFileId: 'remote-1', size: '7', encryptedChecksum: 'bad-checksum' } as BackupCopy)).rejects.toThrow('BACKUP_VERIFICATION_FAILED');
  });
});
