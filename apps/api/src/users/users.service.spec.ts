import { ConflictException } from '@nestjs/common';
import { UsersService } from './users.service';
import { UserRole, UserStatus } from './entities/user.entity';

describe('UsersService', () => {
  const repository = {
    findOne: jest.fn(),
    create: jest.fn((value: Record<string, unknown>) => value),
    save: jest.fn((value: Record<string, unknown>) =>
      Promise.resolve({
        id: 'new-user-id',
        ...value,
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
      }),
    ),
  };
  const service = new UsersService(repository as never);
  const dto = {
    email: 'ana@example.com',
    username: 'ana_cloud',
    password: 'CloudFusion123!',
  };

  beforeEach(() => repository.findOne.mockReset());

  it('rejects a duplicate email', async () => {
    repository.findOne.mockImplementation(
      ({ where }: { where: { email?: string } }) =>
        where.email
          ? Promise.resolve({ id: 'existing-email' })
          : Promise.resolve(null),
    );

    await expect(service.create(dto, 'hashed-password')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('rejects a duplicate username', async () => {
    repository.findOne.mockImplementation(
      ({ where }: { where: { username?: string } }) =>
        where.username
          ? Promise.resolve({ id: 'existing-username' })
          : Promise.resolve(null),
    );

    await expect(service.create(dto, 'hashed-password')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.save).not.toHaveBeenCalled();
  });
});
