import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CloudAccountService } from '../cloud-accounts/cloud-account.service';
import { StorageRule } from './entities/storage-rule.entity';
import { CreateStorageRuleDto } from './dto/create-storage-rule.dto';
import { UpdateStorageRuleDto } from './dto/update-storage-rule.dto';

@Injectable()
export class StorageRuleService {
  constructor(
    @InjectRepository(StorageRule)
    private readonly repository: Repository<StorageRule>,
    private readonly accounts: CloudAccountService,
  ) {}

  async list(userId: string): Promise<StorageRule[]> {
    return this.repository.find({ where: { userId }, order: { priority: 'ASC', createdAt: 'ASC' } });
  }

  async create(userId: string, dto: CreateStorageRuleDto): Promise<StorageRule> {
    await this.validateDestination(userId, dto.destinationAccountId, dto.destinationFolderId);
    const rule = this.repository.create({
      userId,
      name: dto.name.trim(),
      priority: dto.priority,
      enabled: dto.enabled ?? true,
      conditionType: dto.conditionType,
      conditionValue: dto.conditionValue?.trim() || null,
      destinationAccountId: dto.destinationAccountId,
      destinationFolderId: dto.destinationFolderId ?? null,
    });
    return this.repository.save(rule);
  }

  async update(userId: string, id: string, dto: UpdateStorageRuleDto): Promise<StorageRule> {
    const rule = await this.getOwned(userId, id);
    const accountId = dto.destinationAccountId ?? rule.destinationAccountId;
    const folderId = dto.destinationFolderId === undefined ? rule.destinationFolderId : dto.destinationFolderId;
    await this.validateDestination(userId, accountId, folderId ?? undefined);
    Object.assign(rule, {
      ...dto,
      name: dto.name?.trim() ?? rule.name,
      conditionValue: dto.conditionValue === undefined ? rule.conditionValue : dto.conditionValue.trim() || null,
      destinationAccountId: accountId,
      destinationFolderId: folderId ?? null,
    });
    return this.repository.save(rule);
  }

  async remove(userId: string, id: string): Promise<{ deleted: true }> {
    const rule = await this.getOwned(userId, id);
    await this.repository.remove(rule);
    return { deleted: true };
  }

  async getOwned(userId: string, id: string): Promise<StorageRule> {
    const rule = await this.repository.findOne({ where: { id, userId } });
    if (!rule) throw new NotFoundException('STORAGE_RULE_NOT_FOUND');
    return rule;
  }

  private async validateDestination(userId: string, accountId: string, folderId?: string): Promise<void> {
    const context = await this.accounts.getAuthorizedAccount(userId, accountId);
    if (folderId) {
      const folder = await context.adapter.getFile(context.accessToken, accountId, folderId);
      if (folder.type !== 'folder') throw new NotFoundException('DESTINATION_FOLDER_NOT_FOUND');
    }
  }
}
