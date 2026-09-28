import { AsyncPipe, DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthService } from '../../core/auth/auth.service';
import { CloudService } from '../../core/cloud/cloud.service';
import { CloudAccount, CloudFile, CloudProvider, CloudStorageSummary, TransferOperation } from '../../shared/models/cloud.model';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [AsyncPipe, DatePipe, RouterLink],
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly cloudService = inject(CloudService);
  private readonly destroyRef = inject(DestroyRef);

  readonly user$ = this.authService.currentUser$;
  readonly accounts = signal<CloudAccount[]>([]);
  readonly summary = signal<CloudStorageSummary | null>(null);
  readonly files = signal<CloudFile[]>([]);
  readonly selectedAccountId = signal<string | undefined>(undefined);
  readonly parentId = signal<string | undefined>(undefined);
  readonly breadcrumbs = signal<{ id?: string; name: string }[]>([{ name: 'Todos los archivos' }]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly creatingFolder = signal(false);
  readonly transferFile = signal<CloudFile | null>(null);
  readonly transferOperation = signal<TransferOperation>('COPY');
  readonly transferDestinationAccountId = signal<string>('');
  readonly transferDestinationFolderId = signal<string | undefined>(undefined);
  readonly transferDestinationFolders = signal<CloudFile[]>([]);

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      if (params.get('connected')) this.notice.set('Cuenta cloud conectada correctamente.');
      if (params.get('cloudError')) this.error.set('No se pudo completar la conexión cloud.');
    });
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.cloudService.getAccounts().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (accounts) => this.accounts.set(accounts),
      error: () => this.error.set('No se pudieron cargar las cuentas conectadas.'),
    });
    this.cloudService.getStorageSummary().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (summary) => this.summary.set(summary),
      error: () => undefined,
    });
    this.loadFiles();
  }

  loadFiles(): void {
    this.loading.set(true);
    this.cloudService.listFiles(this.selectedAccountId(), this.parentId()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (files) => { this.files.set(this.sortFiles(files)); this.loading.set(false); },
      error: () => { this.error.set('No se pudieron cargar los archivos.'); this.loading.set(false); },
    });
  }

  selectAccount(accountId?: string): void {
    this.selectedAccountId.set(accountId);
    this.parentId.set(undefined);
    const account = accountId ? this.accounts().find((item) => item.id === accountId) : undefined;
    this.breadcrumbs.set([{ name: account ? this.providerLabel(account.provider) : 'Todos los archivos' }]);
    this.loadFiles();
  }

  openFolder(file: CloudFile): void {
    if (file.type !== 'folder') return;
    this.parentId.set(file.id);
    this.breadcrumbs.update((items) => [...items, { id: file.id, name: file.name }]);
    this.loadFiles();
  }

  goToBreadcrumb(index: number): void {
    const item = this.breadcrumbs()[index];
    this.breadcrumbs.set(this.breadcrumbs().slice(0, index + 1));
    this.parentId.set(item.id);
    this.loadFiles();
  }

  connect(provider: CloudProvider): void { this.cloudService.connect(provider); }

  smartUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.loading.set(true);
    this.cloudService.smartUpload(file, this.parentId()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (result) => { input.value = ''; this.notice.set(`Archivo subido a ${this.providerLabel(result.destination.provider as CloudProvider)}.`); this.loadFiles(); },
      error: () => { this.error.set('No se pudo seleccionar un destino con espacio suficiente.'); this.loading.set(false); },
    });
  }

  async createFolder(): Promise<void> {
    const accountId = this.selectedAccountId() ?? this.files()[0]?.accountId;
    if (!accountId) { this.notice.set('Selecciona una cuenta antes de crear una carpeta.'); return; }
    const name = window.prompt('Nombre de la carpeta');
    if (!name?.trim()) return;
    this.cloudService.createFolder(accountId, name.trim(), this.parentId()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.notice.set('Carpeta creada.'); this.loadFiles(); },
      error: () => this.error.set('No se pudo crear la carpeta.'),
    });
  }

  onUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const accountId = this.selectedAccountId() ?? this.files()[0]?.accountId;
    if (!file || !accountId) { this.notice.set('Selecciona una cuenta antes de subir un archivo.'); return; }
    this.loading.set(true);
    this.cloudService.upload(accountId, file, this.parentId()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { input.value = ''; this.notice.set('Archivo subido.'); this.loadFiles(); },
      error: () => { this.error.set('No se pudo subir el archivo.'); this.loading.set(false); },
    });
  }

  rename(file: CloudFile): void {
    const name = window.prompt('Nuevo nombre', file.name);
    if (!name?.trim() || name.trim() === file.name) return;
    this.cloudService.rename(file.accountId, file.id, name.trim()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => this.loadFiles(), error: () => this.error.set('No se pudo renombrar el elemento.') });
  }

  remove(file: CloudFile): void {
    if (!window.confirm(`¿Eliminar ${file.name}?`)) return;
    this.cloudService.remove(file.accountId, file.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.notice.set('Elemento eliminado.'); this.loadFiles(); }, error: () => this.error.set('No se pudo eliminar el elemento.') });
  }

  download(file: CloudFile): void {
    this.cloudService.download(file.accountId, file.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click(); URL.revokeObjectURL(url); },
      error: () => this.error.set('No se pudo descargar el archivo.'),
    });
  }

  disconnect(account: CloudAccount): void {
    this.cloudService.getAccountImpact(account.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (impact) => {
        const effects = [
          impact.objectsOnlyOnThisAccount ? `${impact.objectsOnlyOnThisAccount} objetos sin otra réplica conectada` : '',
          impact.versionsAtRisk ? `${impact.versionsAtRisk} versiones potencialmente inaccesibles` : '',
          impact.snapshotEntriesAtRisk ? `${impact.snapshotEntriesAtRisk} entradas de snapshots asociadas` : '',
          impact.activeBackupPolicies ? `${impact.activeBackupPolicies} políticas de backup activas` : '',
          impact.verifiedBackupsStored ? `${impact.verifiedBackupsStored} copias de backup en esta cuenta` : '',
        ].filter(Boolean);
        const details = effects.length ? `\n\nImpacto detectado:\n• ${effects.join('\n• ')}\n\nEl contenido remoto no se borra, pero puede quedar inaccesible hasta reconectar o reparar las réplicas.` : '';
        if (!window.confirm(`¿Desconectar ${this.providerLabel(account.provider)}?${details}`)) return;
        this.cloudService.disconnect(account.id, true).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: () => { this.notice.set('Cuenta desconectada. Los datos y backups remotos no fueron eliminados.'); this.reload(); },
          error: () => this.error.set('No se pudo desconectar la cuenta.'),
        });
      },
      error: () => this.error.set('No se pudo calcular el impacto; la cuenta no fue desconectada.'),
    });
  }

  refreshAccount(account: CloudAccount): void {
    this.cloudService.refreshAccount(account.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.notice.set('Cuota actualizada.'); this.reload(); }, error: () => this.error.set('La cuenta necesita reconectarse.') });
  }

  openTransfer(file: CloudFile, operation: TransferOperation): void {
    const destination = this.accounts().find((account) => account.status === 'CONNECTED' && account.id !== file.accountId);
    if (!destination) { this.notice.set('Conecta otra cuenta para transferir este archivo.'); return; }
    this.transferFile.set(file);
    this.transferOperation.set(operation);
    this.transferDestinationAccountId.set(destination.id);
    this.transferDestinationFolderId.set(undefined);
    this.loadDestinationFolders();
  }

  closeTransfer(): void { this.transferFile.set(null); this.transferDestinationFolders.set([]); }

  setDestinationAccount(event: Event): void {
    this.transferDestinationAccountId.set((event.target as HTMLSelectElement).value);
    this.transferDestinationFolderId.set(undefined);
    this.loadDestinationFolders();
  }

  loadDestinationFolders(): void {
    const accountId = this.transferDestinationAccountId();
    if (!accountId) { this.transferDestinationFolders.set([]); return; }
    this.cloudService.listFiles(accountId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (files) => this.transferDestinationFolders.set(files.filter((file) => file.type === 'folder')), error: () => this.transferDestinationFolders.set([]) });
  }

  createTransfer(): void {
    const file = this.transferFile();
    const destinationAccountId = this.transferDestinationAccountId();
    if (!file || !destinationAccountId) return;
    this.cloudService.createTransfer({ sourceAccountId: file.accountId, sourceFileId: file.id, destinationAccountId, destinationFolderId: this.transferDestinationFolderId(), operation: this.transferOperation(), conflictStrategy: 'RENAME' }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.closeTransfer(); this.notice.set('Transferencia creada.'); void this.router.navigate(['/transfers']); },
      error: () => this.error.set('No se pudo crear la transferencia.'),
    });
  }

  providerLabel(provider: CloudProvider): string { return provider === 'GOOGLE_DRIVE' ? 'Google Drive' : 'OneDrive'; }
  providerMark(provider: CloudProvider): string { return provider === 'GOOGLE_DRIVE' ? 'G' : 'O'; }
  formatBytes(value: number | null | undefined): string {
    if (!value) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
  }
  usage(account: CloudAccount): number { return account.storage.total ? Math.min(100, (account.storage.used / account.storage.total) * 100) : 0; }
  private sortFiles(files: CloudFile[]): CloudFile[] { return [...files].sort((a, b) => Number(b.type === 'folder') - Number(a.type === 'folder') || a.name.localeCompare(b.name)); }

  logout(): void {
    this.authService.logout().subscribe(() => void this.router.navigate(['/login']));
  }
}
