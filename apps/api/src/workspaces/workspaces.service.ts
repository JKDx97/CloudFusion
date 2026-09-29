import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { WorkspaceMember, WorkspaceRole } from './entities/workspace-member.entity';
import { Workspace } from './entities/workspace.entity';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    @InjectRepository(WorkspaceMember) private readonly members: Repository<WorkspaceMember>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async create(ownerUserId: string, dto: CreateWorkspaceDto) {
    const name = dto.name.trim();
    if (name.length < 2) throw new BadRequestException('Workspace name must contain at least two non-space characters');
    const slug = this.createSlug(name);
    let workspace!: Workspace;

    await this.dataSource.transaction(async (manager) => {
      const workspaceRepository = manager.getRepository(Workspace);
      const memberRepository = manager.getRepository(WorkspaceMember);
      workspace = await workspaceRepository.save(workspaceRepository.create({
        name,
        slug,
        description: dto.description?.trim() || null,
        ownerUserId,
      }));
      await memberRepository.save(memberRepository.create({
        workspaceId: workspace.id,
        userId: ownerUserId,
        role: WorkspaceRole.OWNER,
      }));
    });

    await this.audit.record(ownerUserId, 'WORKSPACE_CREATED', 'Workspace', workspace.id, { slug: workspace.slug });
    return { ...this.toPublicWorkspace(workspace), role: WorkspaceRole.OWNER, memberCount: 1 };
  }

  async list(userId: string, page = 1, limit = 25) {
    const [members, total] = await this.members.createQueryBuilder('member')
      .innerJoinAndSelect('member.workspace', 'workspace')
      .where('member.userId = :userId', { userId })
      .orderBy('workspace.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return {
      items: members.map((member) => ({ ...this.toPublicWorkspace(member.workspace), role: member.role })),
      page,
      limit,
      total,
    };
  }

  async get(userId: string, workspaceId: string) {
    const membership = await this.members.findOne({ where: { workspaceId, userId }, relations: { workspace: true } });
    if (!membership?.workspace) throw new NotFoundException('Workspace not found');
    return { ...this.toPublicWorkspace(membership.workspace), role: membership.role };
  }

  private createSlug(name: string): string {
    const base = name.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'workspace';
    return `${base}-${randomBytes(5).toString('hex')}`;
  }

  private toPublicWorkspace(workspace: Workspace) {
    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      description: workspace.description,
      ownerUserId: workspace.ownerUserId,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  }
}
