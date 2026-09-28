import { NotFoundException } from '@nestjs/common';
import { CloudAccountService } from './cloud-account.service';

describe('CloudAccountService ownership', () => {
  it('does not resolve an account belonging to another user', async () => {
    const repository = { findOne: jest.fn().mockResolvedValue(null) };
    const service = new CloudAccountService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.getOwnedAccount('user-a', 'account-b')).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'account-b', userId: 'user-a' } });
  });
});
