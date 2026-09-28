import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';

@Injectable()
export class AuditService {
  constructor(@InjectRepository(AuditLog) private readonly repository: Repository<AuditLog>) {}

  async record(
    userId: string,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.repository.save(this.repository.create({ userId, action, resourceType, resourceId, metadata }));
  }
}
