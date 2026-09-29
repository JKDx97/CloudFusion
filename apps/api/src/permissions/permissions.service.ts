import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ResourceShareRole } from './entities/resource-share.entity';

export type EffectivePermission = 'NONE' | 'VIEWER' | 'EDITOR' | 'MANAGER' | 'OWNER';

@Injectable()
export class PermissionsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async effectivePermission(userId: string, nodeId: string): Promise<EffectivePermission> {
    const rows = await this.dataSource.query(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent_id, user_id, workspace_id, 0 AS depth
         FROM virtual_nodes
         WHERE id = $1 AND deleted_at IS NULL
         UNION ALL
         SELECT parent.id, parent.parent_id, parent.user_id, parent.workspace_id, ancestors.depth + 1
         FROM virtual_nodes parent
         INNER JOIN ancestors ON parent.id = ancestors.parent_id
         WHERE parent.workspace_id IS NOT DISTINCT FROM ancestors.workspace_id
           AND (parent.workspace_id IS NOT NULL OR parent.user_id = ancestors.user_id)
           AND parent.deleted_at IS NULL
       )
       SELECT CASE
         WHEN (SELECT workspace_id FROM ancestors WHERE depth = 0) IS NULL
          AND (SELECT user_id FROM ancestors WHERE depth = 0) = $2::uuid THEN 'OWNER'
         ELSE COALESCE((
           SELECT grants.permission
           FROM (
             SELECT CASE workspace_members.role::text
                      WHEN 'OWNER' THEN 'OWNER'
                      WHEN 'ADMIN' THEN 'MANAGER'
                      WHEN 'MEMBER' THEN 'EDITOR'
                      ELSE 'VIEWER'
                    END AS permission,
                    CASE workspace_members.role::text
                      WHEN 'OWNER' THEN 4
                      WHEN 'ADMIN' THEN 3
                      WHEN 'MEMBER' THEN 2
                      ELSE 1
                    END AS priority,
                    0 AS depth
             FROM workspace_members
             WHERE workspace_members.workspace_id = (SELECT workspace_id FROM ancestors WHERE depth = 0)
               AND workspace_members.user_id = $2::uuid
             UNION ALL
             SELECT shares.role::text AS permission,
                    CASE shares.role::text WHEN 'EDITOR' THEN 2 ELSE 1 END AS priority,
                    ancestors.depth
             FROM resource_shares shares
             INNER JOIN ancestors ON ancestors.id = shares.node_id
             WHERE shares.shared_with_user_id = $2::uuid
               AND shares.owner_user_id = ancestors.user_id
               AND shares.status = 'ACTIVE'
               AND shares.revoked_at IS NULL
           ) grants
           ORDER BY grants.priority DESC, grants.depth ASC
           LIMIT 1
         ), 'NONE')
       END AS permission`,
      [nodeId, userId],
    ) as Array<{ permission: EffectivePermission }>;

    return rows[0]?.permission ?? 'NONE';
  }

  async canRead(userId: string, nodeId: string): Promise<boolean> {
    return (await this.effectivePermission(userId, nodeId)) !== 'NONE';
  }

  async canWrite(userId: string, nodeId: string): Promise<boolean> {
    const permission = await this.effectivePermission(userId, nodeId);
    return permission === 'OWNER' || permission === 'MANAGER' || permission === ResourceShareRole.EDITOR;
  }

  async canDelete(userId: string, nodeId: string): Promise<boolean> {
    // Editors may move a resource to trash; permanent deletion remains owner-only.
    return this.canWrite(userId, nodeId);
  }

  async canShare(userId: string, nodeId: string): Promise<boolean> {
    const permission = await this.effectivePermission(userId, nodeId);
    return permission === 'OWNER' || permission === 'MANAGER';
  }

  async canManage(userId: string, nodeId: string): Promise<boolean> {
    const permission = await this.effectivePermission(userId, nodeId);
    return permission === 'OWNER' || permission === 'MANAGER';
  }

  async canDownload(userId: string, nodeId: string): Promise<boolean> {
    return this.canRead(userId, nodeId);
  }

  async canUpload(userId: string, nodeId: string): Promise<boolean> {
    return this.canWrite(userId, nodeId);
  }

  async requireRead(userId: string, nodeId: string): Promise<EffectivePermission> {
    const permission = await this.effectivePermission(userId, nodeId);
    if (permission === 'NONE') throw new NotFoundException('Virtual node not found');
    return permission;
  }

  async requireWrite(userId: string, nodeId: string): Promise<EffectivePermission> {
    const permission = await this.effectivePermission(userId, nodeId);
    if (permission === 'NONE') throw new NotFoundException('Virtual node not found');
    if (permission === ResourceShareRole.VIEWER) throw new ForbiddenException('Write permission required');
    return permission;
  }

  async requireOwner(userId: string, nodeId: string): Promise<void> {
    const permission = await this.effectivePermission(userId, nodeId);
    if (permission === 'NONE') throw new NotFoundException('Virtual node not found');
    if (permission !== 'OWNER') throw new ForbiddenException('Resource owner permission required');
  }
}
