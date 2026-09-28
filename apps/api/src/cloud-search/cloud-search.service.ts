import { Injectable } from '@nestjs/common';
import { CloudAccountService } from '../cloud-accounts/cloud-account.service';
import { CloudFile } from '../providers/common/cloud-file.interface';
import { CloudProvider } from '../providers/common/cloud-provider.enum';

export interface CloudSearchResult extends CloudFile {}

export interface CloudSearchFailure {
  accountId: string;
  provider: CloudProvider;
  message: string;
}

@Injectable()
export class CloudSearchService {
  constructor(private readonly accounts: CloudAccountService) {}

  async search(userId: string, query: string): Promise<{
    query: string;
    results: CloudSearchResult[];
    failures: CloudSearchFailure[];
  }> {
    const normalized = query.trim();
    if (!normalized) return { query: normalized, results: [], failures: [] };
    const accounts = (await this.accounts.list(userId)).filter((account) => account.status === 'CONNECTED');
    const settled = await Promise.allSettled(
      accounts.map(async (account) => {
        const context = await this.accounts.getAuthorizedAccount(userId, account.id);
        return context.adapter.searchFiles(context.accessToken, account.id, normalized);
      }),
    );
    const results: CloudFile[] = [];
    const failures: CloudSearchFailure[] = [];
    settled.forEach((result, index) => {
      const account = accounts[index];
      if (result.status === 'fulfilled') results.push(...result.value);
      else failures.push({ accountId: account.id, provider: account.provider, message: 'Provider search failed' });
    });
    results.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '') || a.name.localeCompare(b.name));
    return { query: normalized, results, failures };
  }
}
