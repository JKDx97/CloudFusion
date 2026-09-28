import { Global, Module } from '@nestjs/common';
import { DataProtectionEventsService } from './data-protection-events.service';

@Global()
@Module({
  providers: [DataProtectionEventsService],
  exports: [DataProtectionEventsService],
})
export class RealtimeModule {}
