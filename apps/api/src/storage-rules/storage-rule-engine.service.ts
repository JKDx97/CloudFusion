import { Injectable } from '@nestjs/common';
import { ProviderErrorCode, ProviderException } from '../providers/common/provider-error';
import { CloudAccountService, CloudAccountPublic } from '../cloud-accounts/cloud-account.service';
import { StorageRule } from './entities/storage-rule.entity';
import { StorageRuleConditionType } from './enums/storage-rule-condition.enum';
import { StorageRuleService } from './storage-rule.service';

export interface SmartStorageInput {
  name: string;
  mimeType?: string;
  size: number;
}

export interface SmartStorageDestination {
  account: CloudAccountPublic;
  folderId: string | null;
  ruleId: string | null;
}

@Injectable()
export class StorageRuleEngine {
  constructor(
    private readonly rules: StorageRuleService,
    private readonly accounts: CloudAccountService,
  ) {}

  async select(userId: string, input: SmartStorageInput): Promise<SmartStorageDestination> {
    const accounts = (await this.accounts.list(userId)).filter((account) => account.status === 'CONNECTED');
    const rules = (await this.rules.list(userId)).filter((rule) => rule.enabled).sort((a, b) => a.priority - b.priority);
    for (const rule of rules) {
      if (!this.matches(rule, input)) continue;
      const account = accounts.find((item) => item.id === rule.destinationAccountId);
      if (account && this.hasCapacity(account, input.size)) {
        return { account, folderId: rule.destinationFolderId, ruleId: rule.id };
      }
    }
    const fallback = accounts
      .filter((account) => this.hasCapacity(account, input.size))
      .sort((a, b) => this.freeBytes(b) - this.freeBytes(a))[0];
    if (!fallback) throw new ProviderException(ProviderErrorCode.NO_SUITABLE_STORAGE_PROVIDER, 507);
    return { account: fallback, folderId: null, ruleId: null };
  }

  private matches(rule: StorageRule, input: SmartStorageInput): boolean {
    const value = (rule.conditionValue ?? '').trim().toLowerCase();
    if (rule.conditionType === StorageRuleConditionType.DEFAULT) return true;
    if (rule.conditionType === StorageRuleConditionType.SIZE_GREATER_THAN) return input.size > Number(value);
    if (rule.conditionType === StorageRuleConditionType.MIME) {
      const mime = (input.mimeType ?? '').toLowerCase();
      return value.split(',').some((pattern) => {
        const candidate = pattern.trim();
        return candidate.endsWith('/*') ? mime.startsWith(candidate.slice(0, -1)) : mime === candidate;
      });
    }
    const extension = input.name.includes('.') ? `.${input.name.split('.').pop()!.toLowerCase()}` : '';
    return value.split(',').some((pattern) => {
      const candidate = pattern.trim().replace(/^\*/, '').toLowerCase();
      return candidate === extension || candidate === input.name.toLowerCase();
    });
  }

  private hasCapacity(account: CloudAccountPublic, size: number): boolean {
    return account.storage.total != null && this.freeBytes(account) >= size;
  }

  private freeBytes(account: CloudAccountPublic): number {
    return Math.max(0, (account.storage.total ?? 0) - account.storage.used);
  }
}
