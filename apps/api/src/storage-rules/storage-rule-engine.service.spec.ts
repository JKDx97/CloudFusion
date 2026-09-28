import { ProviderErrorCode, ProviderException } from '../providers/common/provider-error';
import { StorageRuleEngine } from './storage-rule-engine.service';

describe('StorageRuleEngine', () => {
  const account = (id: string, used: number, total: number | null) => ({ id, provider: 'GOOGLE_DRIVE', status: 'CONNECTED', storage: { used, total } });

  it('selects the first matching extension rule by priority', async () => {
    const accounts = { list: jest.fn().mockResolvedValue([account('drive', 10, 1000)]) };
    const rules = { list: jest.fn().mockResolvedValue([{ id: 'rule-1', enabled: true, priority: 10, conditionType: 'EXTENSION', conditionValue: '*.pdf', destinationAccountId: 'drive', destinationFolderId: null }, { id: 'rule-2', enabled: true, priority: 20, conditionType: 'DEFAULT', conditionValue: null, destinationAccountId: 'drive', destinationFolderId: null }]) };
    const destination = await new StorageRuleEngine(rules as never, accounts as never).select('user', { name: 'report.pdf', mimeType: 'application/pdf', size: 20 });
    expect(destination.ruleId).toBe('rule-1');
  });

  it('uses a connected account with known free capacity as fallback', async () => {
    const accounts = { list: jest.fn().mockResolvedValue([account('unknown', 0, null), account('full', 100, 100), account('free', 10, 1000)]) };
    const rules = { list: jest.fn().mockResolvedValue([]) };
    const destination = await new StorageRuleEngine(rules as never, accounts as never).select('user', { name: 'image.png', size: 50 });
    expect(destination.account.id).toBe('free');
    expect(destination.ruleId).toBeNull();
  });

  it('rejects uploads when no suitable provider has enough known space', async () => {
    const accounts = { list: jest.fn().mockResolvedValue([account('unknown', 0, null), account('full', 100, 100)]) };
    const rules = { list: jest.fn().mockResolvedValue([]) };
    await expect(new StorageRuleEngine(rules as never, accounts as never).select('user', { name: 'large.bin', size: 50 })).rejects.toMatchObject({ response: { code: ProviderErrorCode.NO_SUITABLE_STORAGE_PROVIDER } });
  });
});
