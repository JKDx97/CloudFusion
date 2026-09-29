import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiTokenScope } from './api-token-scope';
import { ApiToken } from './entities/api-token.entity';
import { ApiTokensService } from './api-tokens.service';
import { UserStatus } from '../users/entities/user.entity';

describe('ApiTokensService', () => {
  const userId = 'user-1';
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let users: { findOne: jest.Mock };
  let service: ApiTokensService;

  beforeEach(() => {
    repository = {
      create: jest.fn((record) => record),
      save: jest.fn(async (record) => ({ id: 'token-1', createdAt: new Date(), ...record })),
      find: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(),
    };
    users = { findOne: jest.fn().mockResolvedValue({ id: userId }) };
    service = new ApiTokensService(repository as never, users as never);
  });

  it('creates a cryptographically random token and returns its secret only in the create response', async () => {
    const created = await service.create(userId, {
      name: 'WebDAV backup',
      scopes: [ApiTokenScope.FILES_READ, ApiTokenScope.WEBDAV],
    });

    expect(created.token).toMatch(/^cf_live_[A-Za-z0-9_-]{43}$/);
    expect(created.prefix).toBe(created.token.slice(0, 24));
    expect(created).not.toHaveProperty('tokenHash');
    const saved = repository.save.mock.calls[0][0] as ApiToken;
    expect(saved.tokenHash).toBe(createHash('sha256').update(created.token).digest('hex'));
    expect(saved.tokenHash).not.toBe(created.token);
    expect(saved.scopes).toEqual([ApiTokenScope.FILES_READ, ApiTokenScope.WEBDAV]);
  });

  it('rejects already-expired tokens', async () => {
    await expect(service.create(userId, {
      name: 'Expired',
      scopes: [ApiTokenScope.FILES_READ],
      expiresAt: '2000-01-01T00:00:00.000Z',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('lists only safe token fields', async () => {
    repository.find.mockResolvedValue([{
      id: 'token-1', name: 'Read only', prefix: 'cf_live_abcd1234', scopes: [ApiTokenScope.FILES_READ],
      expiresAt: null, lastUsedAt: null, createdAt: new Date(), revokedAt: null, tokenHash: 'secret-hash',
    }]);

    const listed = await service.list(userId);

    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('tokenHash');
    expect(listed[0]).not.toHaveProperty('token');
  });

  it('revokes only a token owned by the requesting user', async () => {
    repository.findOne.mockResolvedValue({
      id: 'token-1', userId, name: 'Desktop', prefix: 'cf_live_abcd1234', scopes: [ApiTokenScope.DESKTOP],
      expiresAt: null, lastUsedAt: null, createdAt: new Date(), revokedAt: null,
    });

    const revoked = await service.revoke(userId, 'token-1');

    expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'token-1', userId } });
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect(revoked).not.toHaveProperty('tokenHash');
  });

  it('returns not found when revoking another user’s token', async () => {
    repository.findOne.mockResolvedValue(null);
    await expect(service.revoke(userId, 'other-token')).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('authenticates with constant-time digest comparison and records last use', async () => {
    const rawToken = `cf_live_${Buffer.from('secure-random-value-should-be-long-enough').toString('base64url').slice(0, 43).padEnd(43, 'x')}`;
    const tokenRecord = {
      id: 'token-1', userId, prefix: rawToken.slice(0, 24), scopes: [ApiTokenScope.FILES_READ],
      expiresAt: null, tokenHash: createHash('sha256').update(rawToken).digest('hex'),
    } as ApiToken;
    const query = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(tokenRecord),
    };
    repository.createQueryBuilder.mockReturnValue(query);

    const principal = await service.verify(rawToken);

    expect(principal).toEqual({ userId, tokenId: 'token-1', scopes: [ApiTokenScope.FILES_READ] });
    expect(query.where).toHaveBeenCalledWith('token.prefix = :prefix', { prefix: rawToken.slice(0, 24) });
    expect(users.findOne).toHaveBeenCalledWith({ where: { id: userId, status: UserStatus.ACTIVE }, select: ['id'] });
    expect(repository.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'token-1' }), expect.objectContaining({ lastUsedAt: expect.any(Date) }));
  });

  it('rejects malformed, unknown and expired tokens', async () => {
    await expect(service.verify('cf_live_not-a-real-token')).rejects.toBeInstanceOf(UnauthorizedException);

    const query = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    repository.createQueryBuilder.mockReturnValue(query);
    const validShape = `cf_live_${'a'.repeat(43)}`;
    await expect(service.verify(validShape)).rejects.toBeInstanceOf(UnauthorizedException);

    query.getOne.mockResolvedValue({
      id: 'expired', userId, prefix: validShape.slice(0, 16), scopes: [],
      expiresAt: new Date(0), tokenHash: createHash('sha256').update(validShape).digest('hex'),
    });
    await expect(service.verify(validShape)).rejects.toThrow('API token expired');
    expect(repository.update).not.toHaveBeenCalled();
  });
});
