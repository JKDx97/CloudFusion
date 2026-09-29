import { Module } from '@nestjs/common';
import { PCloudAdapter } from './pcloud.adapter';

@Module({
  providers: [PCloudAdapter],
  exports: [PCloudAdapter],
})
export class PCloudModule {}
