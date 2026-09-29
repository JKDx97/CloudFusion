import { NotFoundException } from '@nestjs/common';
import { WorkspaceMember, WorkspaceRole } from './entities/workspace-member.entity';
import { Workspace } from './entities/workspace.entity';
import { WorkspacesService } from './workspaces.service';

function fixture() {
  const workspaceRepo = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: Record<string, unknown>) => ({ ...value, id: 'workspace-id', createdAt: new Date(), updatedAt: new Date() })),
    findOne: jest.fn(),
  };
  const memberQuery = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
  };
  const memberRepo = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
    createQueryBuilder: jest.fn(() => memberQuery),
    findOne: jest.fn(),
  };
  const manager = {
    getRepository: jest.fn((entity: unknown) => entity === Workspace ? workspaceRepo : memberRepo),
  };
  const dataSource = {
    transaction: jest.fn(async (work: (manager: typeof manager) => Promise<unknown>) => work(manager)),
  };
  const audit = { record: jest.fn() };
  const service = new WorkspacesService(workspaceRepo as never, memberRepo as never, dataSource as never, audit as never);
  return { service, workspaceRepo, memberRepo, memberQuery, manager, dataSource, audit };
}

describe('WorkspacesService', () => {
  it('creates a workspace and its owner membership atomically', async () => {
    const data = fixture();

    const result = await data.service.create('owner-id', { name: 'Proyecto UPC', description: '  Equipo de tesis  ' });

    expect(data.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(data.workspaceRepo.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Proyecto UPC', description: 'Equipo de tesis', ownerUserId: 'owner-id' }));
    expect(data.memberRepo.save).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-id', userId: 'owner-id', role: WorkspaceRole.OWNER }));
    expect(result).toEqual(expect.objectContaining({ id: 'workspace-id', role: WorkspaceRole.OWNER, memberCount: 1 }));
    expect(data.audit.record).toHaveBeenCalledWith('owner-id', 'WORKSPACE_CREATED', 'Workspace', 'workspace-id', expect.objectContaining({ slug: expect.stringMatching(/^proyecto-upc-[a-f0-9]{10}$/) }));
  });

  it('rejects names consisting only of whitespace', async () => {
    const data = fixture();

    await expect(data.service.create('owner-id', { name: '   ' })).rejects.toThrow('Workspace name must contain at least two non-space characters');
    expect(data.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('lists only memberships belonging to the authenticated user with pagination', async () => {
    const data = fixture();
    data.memberQuery.getManyAndCount.mockResolvedValue([[
      { role: WorkspaceRole.MEMBER, workspace: { id: 'workspace-id', name: 'Equipo', slug: 'equipo-abc', description: null, ownerUserId: 'owner-id', createdAt: new Date(), updatedAt: new Date() } },
    ], 1]);

    const page = await data.service.list('member-id', 2, 10);

    expect(data.memberQuery.where).toHaveBeenCalledWith('member.userId = :userId', { userId: 'member-id' });
    expect(data.memberQuery.skip).toHaveBeenCalledWith(10);
    expect(page.items[0]).toEqual(expect.objectContaining({ id: 'workspace-id', role: WorkspaceRole.MEMBER }));
    expect(page.total).toBe(1);
  });

  it('does not reveal workspace details to non-members', async () => {
    const data = fixture();
    data.memberRepo.findOne.mockResolvedValue(null);

    await expect(data.service.get('outsider-id', 'workspace-id')).rejects.toBeInstanceOf(NotFoundException);
    expect(data.workspaceRepo.findOne).not.toHaveBeenCalled();
  });
});
