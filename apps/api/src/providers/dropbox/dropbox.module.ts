import { Module } from '@nestjs/common';
import { DropboxAdapter } from './dropbox.adapter';
import { DropboxOAuthService } from './dropbox-oauth.service';

@Module({
  providers: [DropboxOAuthService, DropboxAdapter],
  exports: [DropboxAdapter],
})
export class DropboxModule {}
