import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';
import { ApiToken } from './entities/api-token.entity';
import { User } from '../users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ApiToken, User])],
  controllers: [ApiTokensController],
  providers: [ApiTokensService],
  exports: [ApiTokensService],
})
export class ApiTokensModule {}
