import { KeyRotationService } from './key-rotation.service';
import { StorageObject } from '../virtual-fs/entities/storage-object.entity';

describe('KeyRotationService', () => {
  it('rewraps only the authenticated user’s file keys in bounded batches', async () => {
    const oldObject = {
      id: 'object-1',
      userId: 'user-1',
      encryptedDek: 'old-wrap',
      dekIv: 'old-iv',
      dekAuthTag: 'old-tag',
      keyVersion: 1,
    } as StorageObject;
    const selectQuery = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([oldObject]),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const countQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
    };
    const builders = [selectQuery, updateQuery, countQuery];
    const objects = { createQueryBuilder: jest.fn(() => builders.shift()!) };
    const keys = {
      getCurrentVersion: jest.fn().mockReturnValue(2),
      rewrapDataKey: jest.fn().mockReturnValue({ encryptedDek: 'new-wrap', dekIv: 'new-iv', dekAuthTag: 'new-tag', keyVersion: 2 }),
    };
    const service = new KeyRotationService(objects as never, keys as never);

    const result = await service.rotateUserBatch('user-1', undefined, 25);

    expect(result).toEqual({ processed: 1, remaining: 0, nextCursor: null, currentKeyVersion: 2 });
    expect(selectQuery.where).toHaveBeenCalledWith('storageObject.userId = :userId', { userId: 'user-1' });
    expect(selectQuery.take).toHaveBeenCalledWith(25);
    expect(keys.rewrapDataKey).toHaveBeenCalledWith({
      encryptedDek: 'old-wrap', dekIv: 'old-iv', dekAuthTag: 'old-tag', keyVersion: 1,
    }, 'object-1');
    expect(updateQuery.set).toHaveBeenCalledWith({
      encryptedDek: 'new-wrap', dekIv: 'new-iv', dekAuthTag: 'new-tag', keyVersion: 2,
    });
    expect(updateQuery.where).toHaveBeenCalledWith('id = :id AND key_version = :previousVersion', {
      id: 'object-1', previousVersion: 1,
    });
  });
});
