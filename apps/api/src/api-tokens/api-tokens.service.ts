import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { User, UserStatus } from '../users/entities/user.entity';
import { ApiTokenPrincipal, ApiTokenScope } from './api-token-scope';
import { CreateApiTokenDto } from './dto/create-api-token.dto';
import { ApiToken } from './entities/api-token.entity';

type PublicApiToken = Pick<ApiToken,
  'id' | 'name' | 'prefix' | 'scopes' | 'expiresAt' | 'lastUsedAt' | 'createdAt' | 'revokedAt'>;

@Injectable()
export class ApiTokensService {
  constructor(
    @InjectRepository(ApiToken) private readonly repository: Repository<ApiToken>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async create(userId: string, input: CreateApiTokenDto): Promise<PublicApiToken & { token: string }> {
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
      throw new BadRequestException('API token expiration must be in the future');
    }

    const name = input.name.trim();
    if (!name) throw new BadRequestException('API token name is required');
    const token = `cf_live_${randomBytes(32).toString('base64url')}`;
    const record = this.repository.create({
      userId,
      name,
      tokenHash: this.hash(token),
      prefix: token.slice(0, 24),
      scopes: input.scopes,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    });
    const saved = await this.repository.save(record);
    return { ...this.toPublicToken(saved), token };
  }

  async list(userId: string): Promise<PublicApiToken[]> {
    const tokens = await this.repository.find({ where: { userId }, order: { createdAt: 'DESC' } });
    return tokens.map((token) => this.toPublicToken(token));
  }

  async revoke(userId: string, id: string): Promise<PublicApiToken> {
    const token = await this.repository.findOne({ where: { id, userId } });
    if (!token) throw new NotFoundException('API token not found');
    if (!token.revokedAt) {
      token.revokedAt = new Date();
      await this.repository.save(token);
    }
    return this.toPublicToken(token);
  }

  async verify(rawToken: string): Promise<ApiTokenPrincipal> {
    if (!/^cf_live_[A-Za-z0-9_-]{43}$/.test(rawToken)) {
      throw new UnauthorizedException('Invalid API token');
    }

    const prefix = rawToken.slice(0, 24);
    const token = await this.repository.createQueryBuilder('token')
      .addSelect('token.tokenHash')
      .where('token.prefix = :prefix', { prefix })
      .andWhere('token.revokedAt IS NULL')
      .getOne();

    if (!token || !/^[a-f0-9]{64}$/i.test(token.tokenHash)) {
      throw new UnauthorizedException('Invalid API token');
    }
    const storedHash = Buffer.from(token.tokenHash, 'hex');
    const suppliedHash = Buffer.from(this.hash(rawToken), 'hex');
    if (storedHash.length !== suppliedHash.length || !timingSafeEqual(storedHash, suppliedHash)) {
      throw new UnauthorizedException('Invalid API token');
    }
    if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('API token expired');
    }

    const user = await this.users.findOne({ where: { id: token.userId, status: UserStatus.ACTIVE }, select: ['id'] });
    if (!user) throw new UnauthorizedException('API token owner is inactive');

    const update = await this.repository.update({ id: token.id, revokedAt: IsNull() }, { lastUsedAt: new Date() });
    if (update.affected === 0) throw new UnauthorizedException('API token was revoked');
    return { userId: token.userId, tokenId: token.id, scopes: token.scopes };
  }

  private hash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private toPublicToken(token: ApiToken): PublicApiToken {
    const { id, name, prefix, scopes, expiresAt, lastUsedAt, createdAt, revokedAt } = token;
    return { id, name, prefix, scopes, expiresAt, lastUsedAt, createdAt, revokedAt };
  }
}
