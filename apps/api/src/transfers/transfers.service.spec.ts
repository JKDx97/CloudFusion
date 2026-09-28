import { NotFoundException } from '@nestjs/common';
import { TransferService } from './transfers.service';

describe('TransferService ownership', () => {
  it('hides a transfer owned by another user', async () => {
    const repository = { findOne: jest.fn().mockResolvedValue(null) };
    const service = new TransferService(repository as never, {} as never, {} as never, {} as never, {} as never);

    await expect(service.get('user-a', 'transfer-b')).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'transfer-b', userId: 'user-a' } });
  });
});
