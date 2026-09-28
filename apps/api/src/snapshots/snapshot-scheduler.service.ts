import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { VirtualNode } from '../virtual-fs/entities/virtual-node.entity';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';
import { Snapshot } from './entities/snapshot.entity';
import { SnapshotsService } from './snapshots.service';

@Injectable()
export class SnapshotSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SnapshotSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(VirtualNode) private readonly nodes: Repository<VirtualNode>,
    @InjectRepository(Snapshot) private readonly snapshots: Repository<Snapshot>,
    private readonly snapshotService: SnapshotsService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<boolean>('dataProtection.snapshotSchedulerEnabled') === false) return;
    this.timer = setInterval(() => void this.runDueSnapshots().catch((error) => this.logger.warn(`Snapshot scheduler pass failed: ${String(error)}`)), 15 * 60 * 1000);
    void this.runDueSnapshots().catch((error) => this.logger.warn(`Initial snapshot scheduler pass failed: ${String(error)}`));
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async runDueSnapshots(now = new Date()): Promise<number> {
    if (this.running || now.getUTCHours() < 3 || this.config.get<boolean>('dataProtection.snapshotSchedulerEnabled') === false) return 0;
    this.running = true;
    try {
      const day = now.toISOString().slice(0, 10);
      const roots = await this.nodes.find({ where: { isRoot: true, type: VirtualNodeType.FOLDER, deletedAt: IsNull() }, select: { userId: true }, take: 1000 });
      const userIds = [...new Set(roots.map((root) => root.userId))];
      let created = 0;
      for (const userId of userIds) {
        const description = `scheduled:daily:${day}`;
        const existing = await this.snapshots.findOne({ where: { userId, description } });
        if (existing) continue;
        try {
          await this.snapshotService.create(userId, {
            name: `Automático diario ${day}`,
            description,
            isImmutable: true,
          });
          created += 1;
        } catch (error) {
          const duplicate = await this.snapshots.findOne({ where: { userId, description } });
          if (!duplicate) this.logger.warn(`Automatic snapshot was not created for user ${userId}: ${String(error)}`);
        }
      }
      return created;
    } finally { this.running = false; }
  }
}
