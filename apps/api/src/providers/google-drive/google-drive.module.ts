import { Module } from '@nestjs/common';
import { GoogleDriveAdapter } from './google-drive.adapter';
import { GoogleDriveOAuthService } from './google-drive-oauth.service';

@Module({
  providers: [GoogleDriveOAuthService, GoogleDriveAdapter],
  exports: [GoogleDriveAdapter],
})
export class GoogleDriveModule {}
