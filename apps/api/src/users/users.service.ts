import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { RegisterDto } from '../auth/dto/register.dto';
import { User, UserRole, UserStatus } from './entities/user.entity';

export type PublicUser = Omit<User, 'passwordHash' | 'refreshTokenHash' | 'cloudAccounts' | 'p2pEnabled'>;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly usersRepository: Repository<User>,
  ) {}

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async findByIdWithSecrets(id: string): Promise<User | null> {
    return this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .addSelect('user.refreshTokenHash')
      .where('user.id = :id', { id })
      .getOne();
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { email: email.toLowerCase() },
    });
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { username: username.toLowerCase() },
    });
  }

  async findByEmailWithSecrets(email: string): Promise<User | null> {
    return this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .addSelect('user.refreshTokenHash')
      .where('user.email = :email', { email: email.toLowerCase() })
      .getOne();
  }

  async create(dto: RegisterDto, passwordHash: string): Promise<User> {
    const email = dto.email.toLowerCase();
    const username = dto.username.toLowerCase();
    const [emailExists, usernameExists] = await Promise.all([
      this.findByEmail(email),
      this.findByUsername(username),
    ]);

    if (emailExists) throw new ConflictException('Email already registered');
    if (usernameExists) throw new ConflictException('Username already taken');

    try {
      const user = this.usersRepository.create({
        email,
        username,
        passwordHash,
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        refreshTokenHash: null,
      });
      return await this.usersRepository.save(user);
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('Email or username already registered');
      }
      throw error;
    }
  }

  async updateRefreshTokenHash(
    id: string,
    refreshTokenHash: string | null,
  ): Promise<void> {
    await this.usersRepository.update(id, { refreshTokenHash });
  }

  toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === '23505'
    );
  }
}
