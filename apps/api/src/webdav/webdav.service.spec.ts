import { ForbiddenException } from '@nestjs/common';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';
import { WebDavPathService } from './webdav-path.service';
import { WebDavService } from './webdav.service';

describe('WebDavService', () => {
  const userId = 'user-1';
  const file = {
    id: 'file-1', userId, name: 'report.pdf', type: VirtualNodeType.FILE,
    currentVersionId: 'version-4', updatedAt: new Date('2026-09-01T10:00:00Z'),
  };
  const folder = { id: 'folder-1', userId, name: 'Docs', type: VirtualNodeType.FOLDER };
  let drive: Record<string, jest.Mock>;
  let paths: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let config: { get: jest.Mock };
  let service: WebDavService;

  beforeEach(() => {
    drive = {
      getChildren: jest.fn().mockResolvedValue([{ id: 'child', type: VirtualNodeType.FILE }]),
      upload: jest.fn().mockResolvedValue({ node: file }),
      uploadVersion: jest.fn().mockResolvedValue({ node: file }),
      createFolder: jest.fn().mockResolvedValue({ id: 'folder-1', name: 'Docs', type: VirtualNodeType.FOLDER }),
      trash: jest.fn().mockResolvedValue({ deleted: true }),
    };
    paths = {
      resolve: jest.fn().mockResolvedValue(file),
      resolveParent: jest.fn().mockResolvedValue({ id: 'parent-1', type: VirtualNodeType.FOLDER }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    config = { get: jest.fn((key: string) => key === 'webdav.enabled' ? true : 1024) };
    service = new WebDavService(drive as never, paths as unknown as WebDavPathService, audit as never, config as never);
  });

  it('returns only the requested collection depth and rejects unbounded depth', async () => {
    paths.resolve.mockResolvedValueOnce(folder);
    await expect(service.propfind(userId, ['Docs'], '1')).resolves.toHaveLength(2);
    drive.getChildren.mockClear();
    await expect(service.propfind(userId, ['Docs'], 'infinity')).rejects.toBeInstanceOf(ForbiddenException);
    expect(drive.getChildren).not.toHaveBeenCalled();
  });

  it('writes an existing file as a new protected version', async () => {
    const result = await service.put(userId, ['Docs', 'report.pdf'], { originalname: 'report.pdf' } as Express.Multer.File);

    expect(result).toEqual({ node: file, created: false });
    expect(drive.uploadVersion).toHaveBeenCalledWith(userId, file.id, expect.any(Object));
    expect(drive.upload).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(userId, 'WEBDAV_FILE_WRITE', 'VirtualNode', file.id, { versionId: 'version-4' });
  });

  it('creates a virtual folder and deletes through the recoverable trash path', async () => {
    paths.resolve.mockResolvedValueOnce(null);
    await expect(service.createCollection(userId, ['Docs'])).resolves.toMatchObject({ id: 'folder-1' });
    expect(drive.createFolder).toHaveBeenCalledWith(userId, { name: 'Docs', parentId: 'parent-1' });

    paths.resolve.mockResolvedValueOnce(file);
    await service.delete(userId, ['Docs', 'report.pdf']);
    expect(drive.trash).toHaveBeenCalledWith(userId, file.id);
  });

  it('uses the current version identifier as a stable ETag', () => {
    expect(service.etag(file as never)).toBe('"cf-version-4"');
  });
});
