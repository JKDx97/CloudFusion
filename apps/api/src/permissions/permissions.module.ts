import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ResourceShare } from './entities/resource-share.entity';
import { PermissionsService } from './permissions.service';

@Module({
  imports: [TypeOrmModule.forFeature([ResourceShare])],
  providers: [PermissionsService],
  exports: [PermissionsService],
})
export class PermissionsModule {}
