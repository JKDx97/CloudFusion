import { BadRequestException, Injectable } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { CloudAccountService } from '../cloud-accounts/cloud-account.service';
import { CloudProviderResolver } from '../providers/common/cloud-provider-resolver.service';
import { CloudFile, CloudDownload } from '../providers/common/cloud-file.interface';
import { ProviderErrorCode, providerHttpError, ProviderException } from '../providers/common/provider-error';
import { ProviderUploadInput } from '../providers/common/cloud-provider.interface';
import { CreateFolderDto } from './dto/create-folder.dto';

@Injectable()
export class CloudFilesService {
  constructor(
    private readonly accounts: CloudAccountService,
    private readonly resolver: CloudProviderResolver,
  ) {}

  async list(userId: string, accountId?: string, parentId?: string): Promise<CloudFile[]> {
    if (accountId) {
      const context = await this.accounts.getAuthorizedAccount(userId, accountId);
      return this.run(() => context.adapter.listFiles(context.accessToken, accountId, parentId), ProviderErrorCode.PROVIDER_UNAVAILABLE);
    }

    const accounts = await this.accounts.list(userId);
    const files = await Promise.all(
      accounts
        .filter((account) => account.status === 'CONNECTED')
        .map(async (account) => {
          try {
            const context = await this.accounts.getAuthorizedAccount(userId, account.id);
            return await context.adapter.listFiles(context.accessToken, account.id, parentId);
          } catch {
            return [];
          }
        }),
    );
    return files.flat();
  }

  async get(userId: string, accountId: string, fileId: string): Promise<CloudFile> {
    const context = await this.accounts.getAuthorizedAccount(userId, accountId);
    return this.run(() => context.adapter.getFile(context.accessToken, accountId, fileId), ProviderErrorCode.FILE_NOT_FOUND);
  }

  async upload(userId: string, accountId: string, file: Express.Multer.File, parentId?: string): Promise<CloudFile> {
    if (!file) throw new BadRequestException('A file is required');
    const context = await this.accounts.getAuthorizedAccount(userId, accountId);
    const input: ProviderUploadInput = {
      stream: createReadStream(file.path),
      name: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      parentId,
    };
    try {
      return await context.adapter.uploadFile(context.accessToken, accountId, input);
    } catch (error) {
      throw providerHttpError(error, ProviderErrorCode.UPLOAD_FAILED);
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }

  async download(userId: string, accountId: string, fileId: string): Promise<CloudDownload> {
    const context = await this.accounts.getAuthorizedAccount(userId, accountId);
    return this.run(() => context.adapter.downloadFile(context.accessToken, accountId, fileId), ProviderErrorCode.DOWNLOAD_FAILED);
  }

  async createFolder(userId: string, accountId: string, dto: CreateFolderDto): Promise<CloudFile> {
    const context = await this.accounts.getAuthorizedAccount(userId, accountId);
    return this.run(() => context.adapter.createFolder(context.accessToken, accountId, dto.name, dto.parentId), ProviderErrorCode.UPLOAD_FAILED);
  }

  async rename(userId: string, accountId: string, fileId: string, name: string): Promise<CloudFile> {
    const context = await this.accounts.getAuthorizedAccount(userId, accountId);
    return this.run(() => context.adapter.renameItem(context.accessToken, accountId, fileId, name), ProviderErrorCode.FILE_NOT_FOUND);
  }

  async delete(userId: string, accountId: string, fileId: string): Promise<{ deleted: true }> {
    const context = await this.accounts.getAuthorizedAccount(userId, accountId);
    await this.run(() => context.adapter.deleteItem(context.accessToken, accountId, fileId), ProviderErrorCode.FILE_NOT_FOUND);
    return { deleted: true };
  }

  private async run<T>(operation: () => Promise<T>, fallback: ProviderErrorCode): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ProviderException) throw error;
      throw providerHttpError(error, fallback);
    }
  }
}
