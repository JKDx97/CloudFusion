import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DataProtectionException } from './data-protection-error';
import { KeyManagementService } from './key-management.service';
import { StorageObject } from '../virtual-fs/entities/storage-object.entity';

export interface KeyRotationBatchResult {
  processed: number;
  remaining: number;
  nextCursor: string | null;
  currentKeyVersion: number;
}

@Injectable()
export class KeyRotationService {
  constructor(
    @InjectRepository(StorageObject) private readonly objects: Repository<StorageObject>,
    private readonly keys: KeyManagementService,
  ) {}

  async rotateUserBatch(userId: string, cursor?: string, requestedLimit = 100): Promise<KeyRotationBatchResult> {
    const parsedLimit = Math.floor(Number(requestedLimit));
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(500, parsedLimit)) : 100;
    const currentKeyVersion = this.keys.getCurrentVersion();
    const query = this.objects.createQueryBuilder('storageObject')
      .addSelect([
        'storageObject.encryptedDek',
        'storageObject.dekIv',
        'storageObject.dekAuthTag',
      ])
      .where('storageObject.userId = :userId', { userId })
      .andWhere('storageObject.encryptionAlgorithm IS NOT NULL')
      .andWhere('storageObject.keyVersion <> :currentKeyVersion', { currentKeyVersion });
    if (cursor) query.andWhere('storageObject.id > :cursor', { cursor });
    const batch = await query.orderBy('storageObject.id', 'ASC').take(limit).getMany();

    for (const object of batch) {
      if (!object.encryptedDek || !object.dekIv || !object.dekAuthTag || object.keyVersion == null) {
        throw new DataProtectionException('CORRUPTED_ENCRYPTED_OBJECT');
      }
      const wrapped = this.keys.rewrapDataKey({
        encryptedDek: object.encryptedDek,
        dekIv: object.dekIv,
        dekAuthTag: object.dekAuthTag,
        keyVersion: object.keyVersion,
      }, object.id);
      await this.objects.createQueryBuilder()
        .update(StorageObject)
        .set({
          encryptedDek: wrapped.encryptedDek,
          dekIv: wrapped.dekIv,
          dekAuthTag: wrapped.dekAuthTag,
          keyVersion: wrapped.keyVersion,
        })
        .where('id = :id AND key_version = :previousVersion', {
          id: object.id,
          previousVersion: object.keyVersion,
        })
        .execute();
    }

    const nextCursor = batch.length ? batch[batch.length - 1].id : null;
    const remaining = await this.objects.createQueryBuilder('storageObject')
      .where('storageObject.userId = :userId', { userId })
      .andWhere('storageObject.encryptionAlgorithm IS NOT NULL')
      .andWhere('storageObject.keyVersion <> :currentKeyVersion', { currentKeyVersion })
      .getCount();
    return { processed: batch.length, remaining, nextCursor: remaining > 0 ? nextCursor : null, currentKeyVersion };
  }
}
