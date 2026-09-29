import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { UserDevice } from './entities/user-device.entity';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserDevice]), AuditModule],
  controllers: [DevicesController],
  providers: [DevicesService, AccessTokenGuard],
  exports: [DevicesService],
})
export class DevicesModule {}
