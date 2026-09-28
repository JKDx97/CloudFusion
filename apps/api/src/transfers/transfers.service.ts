import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CloudAccountService } from '../cloud-accounts/cloud-account.service';
import { CloudProvider } from '../providers/common/cloud-provider.enum';
import { TransferJob } from './entities/transfer-job.entity';
import { ConflictStrategy } from './enums/conflict-strategy.enum';
import { TransferOperation } from './enums/transfer-operation.enum';
import { TransferStatus } from './enums/transfer-status.enum';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { TransferQueueService } from './transfer-queue.service';
import { TransferProgressService } from './transfer-progress.service';

export interface TransferJobPublic {
  id: string;
  sourceAccountId: string;
  sourceProvider: CloudProvider;
  sourceFileId: string;
  destinationAccountId: string;
  destinationProvider: CloudProvider;
  destinationFolderId: string | null;
  operation: TransferOperation;
  conflictStrategy: ConflictStrategy;
  parentJobId: string | null;
  relativePath: string | null;
  fileName: string;
  fileSize: number | null;
  status: TransferStatus;
  progress: number;
  bytesTransferred: number;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

@Injectable()
export class TransferService {
  constructor(
    @InjectRepository(TransferJob)
    private readonly repository: Repository<TransferJob>,
    private readonly accounts: CloudAccountService,
    private readonly queue: TransferQueueService,
    private readonly progress: TransferProgressService,
  ) {}

  async create(userId: string, dto: CreateTransferDto): Promise<TransferJobPublic> {
    if (dto.sourceAccountId === dto.destinationAccountId) {
      throw new BadRequestException('Source and destination accounts must be different');
    }
    const sourceContext = await this.accounts.getAuthorizedAccount(userId, dto.sourceAccountId);
    const destinationContext = await this.accounts.getAuthorizedAccount(userId, dto.destinationAccountId);
    const sourceFile = await sourceContext.adapter.getFile(
      sourceContext.accessToken,
      dto.sourceAccountId,
      dto.sourceFileId,
    );
    if (dto.destinationFolderId) {
      const folder = await destinationContext.adapter.getFile(
        destinationContext.accessToken,
        dto.destinationAccountId,
        dto.destinationFolderId,
      );
      if (folder.type !== 'folder') throw new BadRequestException('Destination is not a folder');
    }
    const job = this.repository.create({
      userId,
      sourceAccountId: dto.sourceAccountId,
      sourceProvider: sourceContext.account.provider,
      sourceFileId: dto.sourceFileId,
      destinationAccountId: dto.destinationAccountId,
      destinationProvider: destinationContext.account.provider,
      destinationFolderId: dto.destinationFolderId ?? null,
      operation: dto.operation,
      conflictStrategy: dto.conflictStrategy ?? ConflictStrategy.RENAME,
      parentJobId: null,
      relativePath: null,
      fileName: sourceFile.name,
      fileSize: sourceFile.size == null ? null : String(sourceFile.size),
      status: TransferStatus.QUEUED,
      progress: 0,
      bytesTransferred: '0',
      attemptCount: 0,
      errorCode: null,
      errorMessage: null,
      cancelRequested: false,
      startedAt: null,
      completedAt: null,
    });
    const saved = await this.repository.save(job);
    try {
      await this.queue.enqueue(saved.id);
    } catch {
      saved.status = TransferStatus.FAILED;
      saved.errorCode = 'TRANSFER_QUEUE_UNAVAILABLE';
      saved.errorMessage = 'Transfer queue is unavailable';
      await this.repository.save(saved);
      throw new ConflictException('Transfer queue is unavailable');
    }
    this.progress.emit(saved);
    return this.toPublic(saved);
  }

  async list(userId: string, status?: TransferStatus): Promise<TransferJobPublic[]> {
    const jobs = await this.repository.find({
      where: status ? { userId, status } : { userId },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return jobs.map((job) => this.toPublic(job));
  }

  async get(userId: string, id: string): Promise<TransferJobPublic> {
    return this.toPublic(await this.getOwned(userId, id));
  }

  async retry(userId: string, id: string): Promise<TransferJobPublic> {
    const job = await this.getOwned(userId, id);
    if (![TransferStatus.FAILED, TransferStatus.CANCELLED].includes(job.status)) {
      throw new ConflictException('Only failed or cancelled transfers can be retried');
    }
    job.status = TransferStatus.QUEUED;
    job.progress = 0;
    job.bytesTransferred = '0';
    job.errorCode = null;
    job.errorMessage = null;
    job.cancelRequested = false;
    job.completedAt = null;
    const saved = await this.repository.save(job);
    await this.queue.enqueue(saved.id);
    this.progress.emit(saved);
    return this.toPublic(saved);
  }

  async cancel(userId: string, id: string): Promise<TransferJobPublic> {
    const job = await this.getOwned(userId, id);
    if ([TransferStatus.COMPLETED, TransferStatus.FAILED, TransferStatus.CANCELLED].includes(job.status)) {
      return this.toPublic(job);
    }
    job.cancelRequested = true;
    job.status = TransferStatus.CANCELLED;
    job.completedAt = new Date();
    const saved = await this.repository.save(job);
    await this.queue.cancel(id).catch(() => undefined);
    this.progress.emit(saved);
    return this.toPublic(saved);
  }

  async remove(userId: string, id: string): Promise<{ deleted: true }> {
    const job = await this.getOwned(userId, id);
    if ([TransferStatus.PREPARING, TransferStatus.TRANSFERRING, TransferStatus.RETRYING].includes(job.status)) {
      throw new ConflictException('Active transfers must be cancelled before deletion');
    }
    await this.repository.remove(job);
    return { deleted: true };
  }

  async getOwned(userId: string, id: string): Promise<TransferJob> {
    const job = await this.repository.findOne({ where: { id, userId } });
    if (!job) throw new NotFoundException('TRANSFER_NOT_FOUND');
    return job;
  }

  async update(job: TransferJob, patch: Partial<TransferJob>): Promise<TransferJob> {
    Object.assign(job, patch);
    const saved = await this.repository.save(job);
    this.progress.emit(saved);
    return saved;
  }

  toPublic(job: TransferJob): TransferJobPublic {
    return {
      id: job.id,
      sourceAccountId: job.sourceAccountId,
      sourceProvider: job.sourceProvider,
      sourceFileId: job.sourceFileId,
      destinationAccountId: job.destinationAccountId,
      destinationProvider: job.destinationProvider,
      destinationFolderId: job.destinationFolderId,
      operation: job.operation,
      conflictStrategy: job.conflictStrategy,
      parentJobId: job.parentJobId,
      relativePath: job.relativePath,
      fileName: job.fileName,
      fileSize: job.fileSize == null ? null : Number(job.fileSize),
      status: job.status,
      progress: job.progress,
      bytesTransferred: Number(job.bytesTransferred ?? 0),
      attemptCount: job.attemptCount,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      updatedAt: job.updatedAt,
    };
  }
}
