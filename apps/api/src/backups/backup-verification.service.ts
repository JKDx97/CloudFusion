import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CloudAccountService } from '../cloud-accounts/cloud-account.service';
import { BackupCopy } from './entities/backup-copy.entity';

@Injectable()
export class BackupVerificationService {
  constructor(private readonly accounts: CloudAccountService) {}

  async verify(userId: string, copy: BackupCopy): Promise<{ bytes: number; checksum: string }> {
    const context = await this.accounts.getAuthorizedAccount(userId, copy.destinationAccountId);
    const download = await context.adapter.downloadFile(context.accessToken, context.account.id, copy.remoteFileId);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of download.stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(data);
      bytes += data.length;
    }
    const checksum = hash.digest('hex');
    if (bytes !== Number(copy.size) || checksum.toLowerCase() !== copy.encryptedChecksum.toLowerCase()) {
      throw new Error('BACKUP_VERIFICATION_FAILED');
    }
    return { bytes, checksum };
  }
}
