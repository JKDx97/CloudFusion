import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { CloudService } from '../../core/cloud/cloud.service';
import { CreateWorkspaceInvitationResult, WorkspaceMemberRecord, WorkspaceRecord, WorkspaceRole, VirtualNode } from '../../shared/models/cloud.model';

@Component({
  standalone: true,
  imports: [CommonModule, DatePipe, RouterLink],
  selector: 'app-workspace-drive',
  templateUrl: './workspace-drive.component.html',
})
export class WorkspaceDriveComponent implements OnInit {
  private readonly cloud = inject(CloudService);
  private readonly destroyRef = inject(DestroyRef);

  readonly workspaces = signal<WorkspaceRecord[]>([]);
  readonly activeWorkspace = signal<WorkspaceRecord | null>(null);
  readonly root = signal<VirtualNode | null>(null);
  readonly currentFolder = signal<VirtualNode | null>(null);
  readonly breadcrumbs = signal<VirtualNode[]>([]);
  readonly nodes = signal<VirtualNode[]>([]);
  readonly members = signal<WorkspaceMemberRecord[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly workspaceName = signal('');
  readonly workspaceDescription = signal('');
  readonly inviteEmail = signal('');
  readonly inviteRole = signal<WorkspaceRole>('MEMBER');
  readonly invitation = signal<CreateWorkspaceInvitationResult | null>(null);
  readonly invitationToken = signal('');
  readonly managementOpen = signal(false);

  ngOnInit(): void { this.loadWorkspaces(); }

  loadWorkspaces(): void {
    this.loading.set(true);
    this.cloud.listWorkspaces().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (page) => { this.workspaces.set(page.items); this.loading.set(false); },
      error: () => { this.loading.set(false); this.error.set('No se pudieron cargar tus workspaces.'); },
    });
  }

  createWorkspace(): void {
    const name = this.workspaceName().trim();
    if (name.length < 2) { this.error.set('El nombre debe tener al menos 2 caracteres.'); return; }
    this.busy.set(true);
    this.error.set(null);
    this.cloud.createWorkspace(name, this.workspaceDescription().trim() || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (workspace) => {
        this.workspaceName.set('');
        this.workspaceDescription.set('');
        this.busy.set(false);
        this.loadWorkspaces();
        this.openWorkspace(workspace);
      },
      error: () => { this.busy.set(false); this.error.set('No se pudo crear el workspace.'); },
    });
  }

  openWorkspace(workspace: WorkspaceRecord): void {
    this.activeWorkspace.set(workspace);
    this.managementOpen.set(false);
    this.members.set([]);
    this.invitation.set(null);
    this.loading.set(true);
    this.error.set(null);
    this.cloud.getWorkspaceDriveRoot(workspace.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (root) => {
        this.root.set(root);
        this.currentFolder.set(root);
        this.breadcrumbs.set([]);
        this.loadChildren(workspace.id, root.id);
      },
      error: () => { this.loading.set(false); this.error.set('No tienes acceso a este workspace o no pudo abrirse su unidad.'); },
    });
  }

  openFolder(node: VirtualNode): void {
    const workspace = this.activeWorkspace();
    if (!workspace) return;
    this.loading.set(true);
    this.cloud.getWorkspaceDriveChildren(workspace.id, node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (children) => {
        this.currentFolder.set(node);
        this.breadcrumbs.update((items) => [...items, node]);
        this.nodes.set(children);
        this.loading.set(false);
      },
      error: () => { this.loading.set(false); this.error.set('No se pudo abrir esta carpeta.'); },
    });
  }

  goToBreadcrumb(index: number): void {
    const workspace = this.activeWorkspace();
    const root = this.root();
    if (!workspace || !root) return;
    const target = index < 0 ? root : this.breadcrumbs()[index];
    if (!target) return;
    this.loading.set(true);
    this.cloud.getWorkspaceDriveChildren(workspace.id, target.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (children) => {
        this.currentFolder.set(target);
        this.breadcrumbs.set(index < 0 ? [] : this.breadcrumbs().slice(0, index + 1));
        this.nodes.set(children);
        this.loading.set(false);
      },
      error: () => { this.loading.set(false); this.error.set('No se pudo abrir esta carpeta.'); },
    });
  }

  createFolder(): void {
    const workspace = this.activeWorkspace();
    if (!workspace || !this.canWrite()) return;
    const name = window.prompt('Nombre de la carpeta');
    if (!name?.trim()) return;
    this.busy.set(true);
    this.cloud.createWorkspaceFolder(workspace.id, name.trim(), this.currentFolder()?.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.busy.set(false); this.reload(); },
      error: () => { this.busy.set(false); this.error.set('No se pudo crear la carpeta.'); },
    });
  }

  upload(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const workspace = this.activeWorkspace();
    if (!file || !workspace || !this.canWrite()) return;
    this.busy.set(true);
    this.cloud.uploadWorkspaceFile(workspace.id, file, this.currentFolder()?.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.error.set(result.warning ?? null);
        this.reload();
      },
      error: () => { this.busy.set(false); this.error.set('No se pudo subir el archivo al workspace.'); },
    });
  }

  download(node: VirtualNode): void {
    this.cloud.downloadVirtual(node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => this.saveDownload(blob, node.name),
      error: () => this.error.set('No se pudo descargar el archivo o no hay una réplica disponible.'),
    });
  }

  openManagement(): void {
    const workspace = this.activeWorkspace();
    if (!workspace || !this.canManage()) return;
    this.managementOpen.set(!this.managementOpen());
    if (!this.managementOpen()) return;
    this.cloud.getWorkspaceMembers(workspace.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (page) => this.members.set(page.items),
      error: () => this.error.set('No se pudo cargar la lista de miembros.'),
    });
  }

  inviteMember(): void {
    const workspace = this.activeWorkspace();
    const email = this.inviteEmail().trim();
    if (!workspace || !this.canManage() || !email) { this.error.set('Escribe el correo de la persona que quieres invitar.'); return; }
    this.busy.set(true);
    this.error.set(null);
    this.cloud.createWorkspaceInvitation(workspace.id, email, this.inviteRole()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (invitation) => { this.invitation.set(invitation); this.inviteEmail.set(''); this.busy.set(false); },
      error: () => { this.busy.set(false); this.error.set('No se pudo crear la invitación. Revisa si ya existe una invitación activa para ese correo.'); },
    });
  }

  acceptInvitation(): void {
    const token = this.invitationToken().trim();
    if (!token) { this.error.set('Pega el código de invitación.'); return; }
    this.busy.set(true);
    this.cloud.acceptWorkspaceInvitation(token).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.busy.set(false); this.invitationToken.set(''); this.loadWorkspaces(); },
      error: () => { this.busy.set(false); this.error.set('No se pudo aceptar. El código podría haber vencido o pertenecer a otro correo.'); },
    });
  }

  setInviteRole(value: string): void {
    if (value === 'ADMIN' || value === 'MEMBER' || value === 'VIEWER') this.inviteRole.set(value);
  }

  async copyInvitationToken(): Promise<void> {
    const token = this.invitation()?.token;
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
    } catch {
      this.error.set('No se pudo copiar automáticamente. Selecciona y copia el código.');
    }
  }

  changeRole(member: WorkspaceMemberRecord, event: Event): void {
    const workspace = this.activeWorkspace();
    const userId = member.user?.id;
    if (!workspace || !userId) return;
    const value = (event.target as HTMLSelectElement).value;
    if (!['ADMIN', 'MEMBER', 'VIEWER'].includes(value)) return;
    this.cloud.updateWorkspaceMemberRole(workspace.id, userId, value as WorkspaceRole).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.refreshMembers(workspace.id),
      error: () => this.error.set('No se pudo cambiar el rol. Solo el propietario puede asignar administradores.'),
    });
  }

  removeMember(member: WorkspaceMemberRecord): void {
    const workspace = this.activeWorkspace();
    const user = member.user;
    if (!workspace || !user || member.role === 'OWNER') return;
    if (!window.confirm(`¿Quitar a ${user.username} del workspace? Sus archivos no se eliminarán.`)) return;
    this.cloud.removeWorkspaceMember(workspace.id, user.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.refreshMembers(workspace.id),
      error: () => this.error.set('No se pudo quitar al miembro.'),
    });
  }

  canWrite(): boolean { return this.activeWorkspace()?.role !== 'VIEWER'; }
  canManage(): boolean { return ['OWNER', 'ADMIN'].includes(this.activeWorkspace()?.role ?? ''); }

  formatBytes(value: number | null): string {
    if (value == null) return '—';
    if (value === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
  }

  private loadChildren(workspaceId: string, nodeId: string): void {
    this.cloud.getWorkspaceDriveChildren(workspaceId, nodeId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (nodes) => { this.nodes.set(nodes); this.loading.set(false); },
      error: () => { this.loading.set(false); this.error.set('No se pudo cargar el contenido de la unidad.'); },
    });
  }

  private reload(): void {
    const workspace = this.activeWorkspace();
    const folder = this.currentFolder();
    if (workspace && folder) this.loadChildren(workspace.id, folder.id);
  }

  private refreshMembers(workspaceId: string): void {
    this.cloud.getWorkspaceMembers(workspaceId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (page) => this.members.set(page.items),
      error: () => this.error.set('No se pudo actualizar la lista de miembros.'),
    });
  }

  private saveDownload(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
