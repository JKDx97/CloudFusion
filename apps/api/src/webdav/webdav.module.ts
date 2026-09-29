import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';
import { AuditModule } from '../audit/audit.module';
import { VirtualFsModule } from '../virtual-fs/virtual-fs.module';
import { WebDavAuthGuard } from './webdav-auth.guard';
import { WebDavController } from './webdav.controller';
import { WebDavPathService } from './webdav-path.service';
import { WebDavService } from './webdav.service';

@Module({
  imports: [ApiTokensModule, AuditModule, ConfigModule, VirtualFsModule],
  controllers: [WebDavController],
  providers: [WebDavAuthGuard, WebDavPathService, WebDavService],
})
export class WebDavModule {}
