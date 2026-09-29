import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import configuration from './config/configuration';
import { User } from './users/entities/user.entity';
import { UsersModule } from './users/users.module';
import { CloudAccount } from './cloud-accounts/entities/cloud-account.entity';
import { CloudAccountsModule } from './cloud-accounts/cloud-accounts.module';
import { CloudFilesModule } from './cloud-files/cloud-files.module';
import { TransferJob } from './transfers/entities/transfer-job.entity';
import { TransfersModule } from './transfers/transfers.module';
import { CloudSearchModule } from './cloud-search/cloud-search.module';
import { StorageRulesModule } from './storage-rules/storage-rules.module';
import { StorageRule } from './storage-rules/entities/storage-rule.entity';
import { AuditLog } from './audit/entities/audit-log.entity';
import { AuditModule } from './audit/audit.module';
import { VirtualNode } from './virtual-fs/entities/virtual-node.entity';
import { StorageObject } from './virtual-fs/entities/storage-object.entity';
import { StorageReplica } from './virtual-fs/entities/storage-replica.entity';
import { StoragePolicy } from './virtual-fs/entities/storage-policy.entity';
import { VirtualFsModule } from './virtual-fs/virtual-fs.module';
import { SnapshotsModule } from './snapshots/snapshots.module';
import { BackupsModule } from './backups/backups.module';
import { ProtectionModule } from './protection/protection.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ApiTokensModule } from './api-tokens/api-tokens.module';
import { ApiToken } from './api-tokens/entities/api-token.entity';
import { WebDavModule } from './webdav/webdav.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { P2pModule } from './p2p/p2p.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
    }),
    RealtimeModule,
    P2pModule,
    ApiTokensModule,
    WebDavModule,
    WorkspacesModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('database.host'),
        port: config.get<number>('database.port'),
        username: config.get<string>('database.user'),
        password: config.get<string>('database.password'),
        database: config.get<string>('database.name'),
        autoLoadEntities: true,
        entities: [User, CloudAccount, TransferJob, StorageRule, AuditLog, VirtualNode, StorageObject, StorageReplica, StoragePolicy, ApiToken],
        migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
        synchronize: false,
        migrationsRun: false,
        retryAttempts: 1,
      }),
    }),
    UsersModule,
    AuthModule,
    CloudAccountsModule,
    CloudFilesModule,
    TransfersModule,
    CloudSearchModule,
    StorageRulesModule,
    AuditModule,
    VirtualFsModule,
    SnapshotsModule,
    BackupsModule,
    ProtectionModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
