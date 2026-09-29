import { Module } from '@nestjs/common';
import { BoxAdapter } from './box.adapter';
import { BoxOAuthService } from './box-oauth.service';

@Module({
  providers: [BoxOAuthService, BoxAdapter],
  exports: [BoxAdapter],
})
export class BoxModule {}
