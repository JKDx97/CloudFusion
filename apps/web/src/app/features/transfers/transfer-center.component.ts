import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CloudService } from '../../core/cloud/cloud.service';
import { TransferJob, TransferStatus } from '../../shared/models/cloud.model';

type TransferFilter = 'ALL' | 'ACTIVE' | 'COMPLETED' | 'FAILED';

@Component({
  selector: 'app-transfer-center',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './transfer-center.component.html',
})
export class TransferCenterComponent {
  private readonly cloud = inject(CloudService);
  private readonly destroyRef = inject(DestroyRef);
  readonly transfers = signal<TransferJob[]>([]);
  readonly filter = signal<TransferFilter>('ALL');
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  private readonly eventSubscriptions = new Set<string>();

  constructor() { this.reload(); }

  reload(): void {
    this.loading.set(true);
    this.cloud.getTransfers().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (items) => { this.transfers.set(items); this.loading.set(false); items.filter((item) => this.isActive(item.status)).forEach((item) => this.listen(item.id)); },
      error: () => { this.error.set('No se pudo cargar el historial de transferencias.'); this.loading.set(false); },
    });
  }

  visible(): TransferJob[] {
    const selected = this.filter();
    return this.transfers().filter((item) => selected === 'ALL' || (selected === 'ACTIVE' && this.isActive(item.status)) || (selected === 'COMPLETED' && item.status === 'COMPLETED') || (selected === 'FAILED' && ['FAILED', 'CANCELLED'].includes(item.status)));
  }

  cancel(item: TransferJob): void {
    this.cloud.cancelTransfer(item.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (updated) => this.replace(updated), error: () => this.error.set('No se pudo cancelar la transferencia.') });
  }

  retry(item: TransferJob): void {
    this.cloud.retryTransfer(item.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (updated) => { this.replace(updated); this.listen(updated.id); }, error: () => this.error.set('No se pudo reintentar la transferencia.') });
  }

  remove(item: TransferJob): void {
    this.cloud.deleteTransfer(item.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => this.transfers.update((items) => items.filter((current) => current.id !== item.id)), error: () => this.error.set('No se pudo eliminar el historial.') });
  }

  isActive(status: TransferStatus): boolean { return ['QUEUED', 'PREPARING', 'TRANSFERRING', 'RETRYING'].includes(status); }
  providerLabel(provider: string): string { return provider === 'GOOGLE_DRIVE' ? 'Google Drive' : 'OneDrive'; }
  statusLabel(status: TransferStatus): string { return ({ QUEUED: 'En cola', PREPARING: 'Preparando', TRANSFERRING: 'Transfiriendo', COMPLETED: 'Completado', FAILED: 'Fallido', CANCELLED: 'Cancelado', RETRYING: 'Reintentando' } as Record<TransferStatus, string>)[status]; }
  formatBytes(value: number | null): string {
    if (!value) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
  }

  private listen(id: string): void {
    if (this.eventSubscriptions.has(id)) return;
    this.eventSubscriptions.add(id);
    this.cloud.streamTransfer(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (event) => this.transfers.update((items) => items.map((item) => item.id === id ? { ...item, status: event.status, progress: event.progress, bytesTransferred: event.bytesTransferred, fileSize: event.fileSize, errorCode: event.errorCode, errorMessage: event.errorMessage } : item)), error: () => undefined });
  }

  private replace(updated: TransferJob): void { this.transfers.update((items) => items.map((item) => item.id === updated.id ? updated : item)); }
}
