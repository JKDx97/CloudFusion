export enum ApiTokenScope {
  FILES_READ = 'files:read',
  FILES_WRITE = 'files:write',
  FILES_DELETE = 'files:delete',
  WEBDAV = 'webdav',
  S3 = 's3',
  SYNC = 'sync',
  DESKTOP = 'desktop',
}

export interface ApiTokenPrincipal {
  userId: string;
  tokenId: string;
  scopes: ApiTokenScope[];
}
