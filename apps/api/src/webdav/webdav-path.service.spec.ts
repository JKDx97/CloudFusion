import { BadRequestException } from '@nestjs/common';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';
import { WebDavPathService } from './webdav-path.service';

describe('WebDavPathService', () => {
  it('decodes a path below /dav and ignores its query string', () => {
    const paths = new WebDavPathService({} as never);
    expect(paths.parsePath('/dav/Universidad/tesis%20final.pdf?download=1')).toEqual(['Universidad', 'tesis final.pdf']);
    expect(paths.parsePath('/dav/')).toEqual([]);
  });

  it('rejects path traversal, encoded separators, malformed escapes and paths outside the DAV root', () => {
    const paths = new WebDavPathService({} as never);
    for (const url of ['/dav/../secret', '/dav/%2e%2e/secret', '/dav/a%2Fb', '/dav/%ZZ', '/davish/file']) {
      expect(() => paths.parsePath(url)).toThrow(BadRequestException);
    }
  });

  it('encodes href segments and adds a trailing slash only for collections', () => {
    const paths = new WebDavPathService({} as never);
    expect(paths.href([], true)).toBe('/dav/');
    expect(paths.href(['Proyectos 2026', 'tesis#final.pdf'], false)).toBe('/dav/Proyectos%202026/tesis%23final.pdf');
    expect(paths.href(['Fotos'], true)).toBe('/dav/Fotos/');
  });

  it('resolves each path segment through owned virtual children only', async () => {
    const root = { id: 'root', type: VirtualNodeType.FOLDER };
    const folder = { id: 'folder', name: 'Fotos', type: VirtualNodeType.FOLDER };
    const file = { id: 'file', name: 'vacaciones.jpg', type: VirtualNodeType.FILE };
    const drive = {
      getRoot: jest.fn().mockResolvedValue(root),
      getChildren: jest.fn().mockResolvedValueOnce([folder]).mockResolvedValueOnce([file]),
    };
    const paths = new WebDavPathService(drive as never);

    await expect(paths.resolve('user-1', ['Fotos', 'vacaciones.jpg'])).resolves.toBe(file);
    expect(drive.getChildren).toHaveBeenNthCalledWith(1, 'user-1', 'root');
    expect(drive.getChildren).toHaveBeenNthCalledWith(2, 'user-1', 'folder');
  });
});
