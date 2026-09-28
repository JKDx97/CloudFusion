import { Readable } from 'node:stream';
import { ProviderErrorCode, ProviderException } from '../providers/common/provider-error';
import { TransferExecutionService } from './transfer-execution.service';
import { TransferOperation } from './enums/transfer-operation.enum';
import { TransferStatus } from './enums/transfer-status.enum';
import { TransferJob } from './entities/transfer-job.entity';

function createFixture(operation: TransferOperation) {
  let uploaded = false;
  const sourceAdapter = {
    getFile: jest.fn().mockResolvedValue({ id: 'source-file', accountId: 'source', provider: 'GOOGLE_DRIVE', name: 'report.pdf', type: 'file', mimeType: 'application/pdf', size: 5 }),
    downloadFile: jest.fn().mockResolvedValue({ stream: Readable.from(Buffer.from('hello')), fileName: 'report.pdf', mimeType: 'application/pdf', size: 5 }),
    deleteItem: jest.fn().mockResolvedValue(undefined),
  };
  const destinationAdapter = {
    listFiles: jest.fn().mockImplementation(async () => uploaded ? [{ id: 'dest-file', accountId: 'destination', provider: 'ONEDRIVE', name: 'report.pdf', type: 'file', size: 5 }] : []),
    uploadFile: jest.fn().mockImplementation(async (_token: string, _accountId: string, input: { stream: Readable }) => { for await (const _chunk of input.stream) { /* consume the stream */ } uploaded = true; return { id: 'dest-file', accountId: 'destination', provider: 'ONEDRIVE', name: 'report.pdf', type: 'file', size: 5 }; }),
  };
  const job = { id: 'transfer-id', userId: 'user-id', sourceAccountId: 'source', sourceProvider: 'GOOGLE_DRIVE', sourceFileId: 'source-file', destinationAccountId: 'destination', destinationProvider: 'ONEDRIVE', destinationFolderId: null, operation, conflictStrategy: 'RENAME', parentJobId: null, relativePath: null, fileName: 'report.pdf', fileSize: '5', status: TransferStatus.QUEUED, progress: 0, bytesTransferred: '0', attemptCount: 0, errorCode: null, errorMessage: null, cancelRequested: false, startedAt: null, completedAt: null, createdAt: new Date(), updatedAt: new Date() } as unknown as TransferJob;
  const repository = { findOne: jest.fn().mockResolvedValue(job), save: jest.fn().mockImplementation(async (value: TransferJob) => value) };
  const accounts = { getAuthorizedAccount: jest.fn().mockResolvedValueOnce({ account: { id: 'source' }, accessToken: 'source-token', adapter: sourceAdapter }).mockResolvedValueOnce({ account: { id: 'destination' }, accessToken: 'destination-token', adapter: destinationAdapter }) };
  const progress = { emit: jest.fn() };
  const config = { get: jest.fn().mockReturnValue(0) };
  const queueJob = { updateProgress: jest.fn().mockResolvedValue(undefined) };
  const service = new TransferExecutionService(repository as never, accounts as never, progress as never, config as never);
  return { service, job, sourceAdapter, destinationAdapter, queueJob };
}

describe('TransferExecutionService', () => {
  it('copies a stream without loading the whole file into a buffer and verifies the destination', async () => {
    const fixture = createFixture(TransferOperation.COPY);
    await fixture.service.execute('transfer-id', fixture.queueJob as never);
    expect(fixture.destinationAdapter.uploadFile).toHaveBeenCalled();
    expect(fixture.sourceAdapter.deleteItem).not.toHaveBeenCalled();
    expect(fixture.job.status).toBe(TransferStatus.COMPLETED);
  });

  it('moves only after the destination has been verified', async () => {
    const fixture = createFixture(TransferOperation.MOVE);
    await fixture.service.execute('transfer-id', fixture.queueJob as never);
    expect(fixture.sourceAdapter.deleteItem).toHaveBeenCalledWith('source-token', 'source', 'source-file');
  });

  it('does not delete the source when upload fails', async () => {
    const fixture = createFixture(TransferOperation.MOVE);
    fixture.destinationAdapter.uploadFile.mockRejectedValueOnce(new Error('upload failed'));
    await expect(fixture.service.execute('transfer-id', fixture.queueJob as never)).rejects.toBeInstanceOf(ProviderException);
    expect(fixture.sourceAdapter.deleteItem).not.toHaveBeenCalled();
  });

  it('returns a recoverable error when deleting the source fails after copy', async () => {
    const fixture = createFixture(TransferOperation.MOVE);
    fixture.sourceAdapter.deleteItem.mockRejectedValueOnce(new Error('delete failed'));
    await expect(fixture.service.execute('transfer-id', fixture.queueJob as never)).rejects.toMatchObject({ response: { code: ProviderErrorCode.MOVE_SOURCE_DELETE_FAILED } });
  });
});
