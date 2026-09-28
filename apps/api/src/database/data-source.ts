import 'dotenv/config';
import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { CloudAccount } from '../cloud-accounts/entities/cloud-account.entity';
import { TransferJob } from '../transfers/entities/transfer-job.entity';
import { StorageRule } from '../storage-rules/entities/storage-rule.entity';

export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  username: process.env.DATABASE_USER ?? 'cloudfusion',
  password: process.env.DATABASE_PASSWORD ?? 'change_me_local',
  database: process.env.DATABASE_NAME ?? 'cloudfusion',
  entities: [User, CloudAccount, TransferJob, StorageRule],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
});
