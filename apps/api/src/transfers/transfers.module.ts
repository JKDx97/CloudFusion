import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransferJob } from './entities/transfer-job.entity';

@Module({
  imports: [TypeOrmModule.forFeature([TransferJob])],
})
export class TransfersModule {}
