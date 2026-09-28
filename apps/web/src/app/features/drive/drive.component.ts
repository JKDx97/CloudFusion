import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { CloudService } from '../../core/cloud/cloud.service';
import { FileVersionRecord, VirtualNode } from '../../shared/models/cloud.model';

type DriveSection = 'drive' | 'recent' | 'favorites' | 'trash';

@Component({
  standalone: true,
  imports: [CommonModule, DatePipe, RouterLink],
  selector: 'app-drive',
  templateUrl: './drive.component.html',
})
export class DriveComponent implements OnInit {
  private readonly cloud = inject(CloudService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  readonly nodes = signal<VirtualNode[]>([]);
  readonly breadcrumbs = signal<VirtualNode[]>([]);
  readonly root = signal<VirtualNode | null>(null);
  readonly currentParent = signal<VirtualNode | null>(null);
  readonly section = signal<DriveSection>('drive');
  readonly loading = signal(false);
  readonly notice = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly versionTarget = signal<VirtualNode | null>(null);
  readonly versions = signal<FileVersionRecord[]>([]);
  readonly versionLoading = signal(false);
  readonly versionComment = signal('');

  ngOnInit(): void { this.openDrive(); }

  openDrive(): void {
    this.section.set('drive');
    this.loading.set(true);
    this.cloud.getVirtualRoot().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (root) => {
        this.root.set(root);
        this.currentParent.set(root);
        this.breadcrumbs.set([]);
        this.loadChildren(root);
      },
      error: () => this.fail('No se pudo abrir CloudFusion Drive.'),
    });
  }

  openSection(section: DriveSection): void {
    if (section === 'drive') { this.openDrive(); return; }
    this.section.set(section);
    this.currentParent.set(null);
    this.breadcrumbs.set([]);
    this.loading.set(true);
    const request = section === 'recent' ? this.cloud.getVirtualRecent() : section === 'favorites' ? this.cloud.getVirtualFavorites() : this.cloud.getVirtualTrash();
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (nodes) => { this.nodes.set(nodes); this.loading.set(false); }, error: () => this.fail('No se pudo cargar esta vista.') });
  }

  openFolder(node: VirtualNode): void {
    this.section.set('drive');
    this.loading.set(true);
    this.cloud.getVirtualChildren(node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (nodes) => { this.currentParent.set(node); this.breadcrumbs.update((items) => [...items, node]); this.nodes.set(nodes); this.loading.set(false); },
      error: () => this.fail('No se pudo abrir la carpeta.'),
    });
  }

  goTo(index: number): void {
    if (index < 0) { this.openDrive(); return; }
    const target = this.breadcrumbs()[index];
    if (!target) return;
    this.loading.set(true);
    this.cloud.getVirtualChildren(target.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (nodes) => { this.currentParent.set(target); this.breadcrumbs.set(this.breadcrumbs().slice(0, index + 1)); this.nodes.set(nodes); this.loading.set(false); },
      error: () => this.fail('No se pudo abrir la carpeta.'),
    });
  }

  createFolder(): void {
    const name = window.prompt('Nombre de la carpeta');
    if (!name?.trim()) return;
    this.cloud.createVirtualFolder(name.trim(), this.currentParent()?.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.announce('Carpeta creada.'); this.reload(); }, error: () => this.fail('No se pudo crear la carpeta.') });
  }

  upload(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = '';
    if (!file) return;
    this.cloud.uploadVirtual(file, this.currentParent()?.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (result) => { this.announce(result.warning ?? (result.queued ? 'Archivo encolado para replicación.' : 'Archivo creado sin réplica física.')); this.reload(); }, error: () => this.fail('No se pudo iniciar la carga.') });
  }

  openVersions(node: VirtualNode): void {
    this.versionTarget.set(node);
    this.versionComment.set('');
    this.versionLoading.set(true);
    this.cloud.getFileVersions(node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (versions) => { this.versions.set(versions); this.versionLoading.set(false); },
      error: () => { this.versionLoading.set(false); this.fail('No se pudo cargar el historial de versiones.'); },
    });
  }

  closeVersions(): void { this.versionTarget.set(null); this.versions.set([]); }

  uploadVersion(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const target = this.versionTarget();
    if (!file || !target) return;
    this.cloud.uploadFileVersion(target.id, file, this.versionComment()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (result) => {
        this.announce(result.queued ? `Versión ${result.version.versionNumber} guardada y encolada.` : `Versión ${result.version.versionNumber} guardada.`);
        this.openVersions(result.node);
        this.reload();
      },
      error: () => this.fail('No se pudo guardar la nueva versión.'),
    });
  }

  downloadVersion(version: FileVersionRecord): void {
    const target = this.versionTarget();
    if (!target) return;
    this.cloud.downloadFileVersion(target.id, version.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => this.saveDownload(blob, `${target.name}.v${version.versionNumber}`),
      error: () => this.fail('No se pudo descargar esa versión.'),
    });
  }

  restoreVersion(version: FileVersionRecord): void {
    const target = this.versionTarget();
    if (!target || version.current || !window.confirm(`¿Restaurar la versión ${version.versionNumber}? Se guardará como una versión nueva.`)) return;
    this.cloud.restoreFileVersion(target.id, version.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (node) => { this.announce(`La versión ${version.versionNumber} se restauró como una nueva versión.`); this.openVersions(node); this.reload(); },
      error: () => this.fail('No se pudo restaurar la versión.'),
    });
  }

  rename(node: VirtualNode): void {
    const name = window.prompt('Nuevo nombre', node.name);
    if (!name?.trim() || name.trim() === node.name) return;
    this.cloud.renameVirtual(node.id, name.trim()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.announce('Nombre actualizado.'); this.reload(); }, error: () => this.fail('No se pudo renombrar el elemento.') });
  }

  toggleFavorite(node: VirtualNode): void {
    this.cloud.setVirtualFavorite(node.id, !node.isFavorite).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.announce(node.isFavorite ? 'Quitado de favoritos.' : 'Añadido a favoritos.'); this.reload(); }, error: () => this.fail('No se pudo actualizar favoritos.') });
  }

  trash(node: VirtualNode): void {
    if (!window.confirm(`¿Enviar “${node.name}” a la papelera?`)) return;
    this.cloud.trashVirtual(node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.announce('Elemento enviado a la papelera.'); this.reload(); }, error: () => this.fail('No se pudo enviar a la papelera.') });
  }

  restore(node: VirtualNode): void {
    this.cloud.restoreVirtual(node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.announce('Elemento restaurado.'); this.reload(); }, error: () => this.fail('No se pudo restaurar el elemento.') });
  }

  permanentDelete(node: VirtualNode): void {
    if (!window.confirm(`¿Eliminar permanentemente “${node.name}”?`)) return;
    this.cloud.permanentDeleteVirtual(node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.announce('Elemento eliminado permanentemente.'); this.reload(); }, error: () => this.fail('No se pudo eliminar permanentemente.') });
  }

  rebalance(): void {
    this.cloud.rebalanceVirtual().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (result) => this.announce(`${result.queued} reparaciones encoladas.`), error: () => this.fail('No se pudo iniciar el rebalanceo.') });
  }

  download(node: VirtualNode): void {
    this.cloud.downloadVirtual(node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => this.saveDownload(blob, node.name),
      error: () => this.fail('No hay una réplica disponible para descargar.'),
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

  formatBytes(value: number | null): string {
    if (!value) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
  }

  statusLabel(status: VirtualNode['status']): string { return ({ AVAILABLE: 'Disponible', UPLOADING: 'Subiendo', DEGRADED: 'Degradado', UNAVAILABLE: 'Sin réplica', DELETING: 'En papelera', ERROR: 'Error' } satisfies Record<VirtualNode['status'], string>)[status]; }
  isTrash(): boolean { return this.section() === 'trash'; }
  title(): string { return ({ drive: 'Mi Drive', recent: 'Recientes', favorites: 'Favoritos', trash: 'Papelera' } as Record<DriveSection, string>)[this.section()]; }

  private loadChildren(root: VirtualNode): void { this.cloud.getVirtualChildren(root.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (nodes) => { this.nodes.set(nodes); this.loading.set(false); }, error: () => this.fail('No se pudo cargar el contenido.') }); }
  private reload(): void { this.section() === 'drive' ? (this.currentParent() ? this.loadChildren(this.currentParent() as VirtualNode) : this.openDrive()) : this.openSection(this.section()); }
  private announce(message: string): void { this.notice.set(message); this.error.set(null); }
  private fail(message: string): void { this.loading.set(false); this.error.set(message); }
}
