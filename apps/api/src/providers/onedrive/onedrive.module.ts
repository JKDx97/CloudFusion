import { Module } from '@nestjs/common';
import { OneDriveAdapter } from './onedrive.adapter';
import { OneDriveOAuthService } from './onedrive-oauth.service';

@Module({
  providers: [OneDriveOAuthService, OneDriveAdapter],
  exports: [OneDriveAdapter],
})
export class OneDriveModule {}
