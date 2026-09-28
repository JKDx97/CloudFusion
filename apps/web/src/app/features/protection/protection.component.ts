import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { interval, startWith, switchMap } from 'rxjs';
import { CloudService } from '../../core/cloud/cloud.service';
import { SnapshotEntryRecord, SnapshotRecord, SnapshotRestoreJobRecord } from '../../shared/models/cloud.model';

@Component({
  standalone: true,
  imports: [CommonModule, DatePipe, FormsModule, RouterLink],
  selector: 'app-protection',
  templateUrl: './protection.component.html',
})
export class ProtectionComponent implements OnInit {
  private readonly cloud = inject(CloudService);
  private readonly destroyRef = inject(DestroyRef);
  readonly snapshots = signal<SnapshotRecord[]>([]);
  readonly entries = signal<SnapshotEntryRecord[]>([]);
  readonly jobs = signal<SnapshotRestoreJobRecord[]>([]);
  readonly selected = signal<SnapshotRecord | null>(null);
  readonly name = signal('');
  readonly description = signal('');
  readonly immutable = signal(true);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  ngOnInit(): void {
    this.refresh();
    interval(4000).pipe(startWith(0), switchMap(() => this.cloud.listSnapshotRestoreJobs()), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (jobs) => this.jobs.set(jobs),
      error: () => undefined,
    });
  }

  refresh(): void {
    this.cloud.listSnapshots().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (snapshots) => this.snapshots.set(snapshots),
      error: () => this.fail('No se pudieron cargar los snapshots.'),
    });
  }

  createSnapshot(): void {
    const name = this.name().trim();
    if (!name) { this.fail('Escribe un nombre para el punto de recuperación.'); return; }
    this.busy.set(true);
    this.cloud.createSnapshot(name, this.description().trim() || undefined, this.immutable()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (snapshot) => {
        this.busy.set(false);
        this.name.set('');
        this.description.set('');
        this.selected.set(snapshot);
        this.entries.set([]);
        this.notice.set('Punto de recuperación creado.');
        this.error.set(null);
        this.refresh();
      },
      error: () => { this.busy.set(false); this.fail('No se pudo crear el snapshot.'); },
    });
  }

  browse(snapshot: SnapshotRecord): void {
    this.selected.set(snapshot);
    this.entries.set([]);
    this.cloud.getSnapshotEntries(snapshot.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (entries) => this.entries.set(entries),
      error: () => this.fail('No se pudieron explorar los contenidos protegidos.'),
    });
  }

  restoreEntry(entry: SnapshotEntryRecord): void {
    const snapshot = this.selected();
    if (!snapshot || entry.isRoot || !window.confirm(`¿Restaurar “${entry.name}” conservando cualquier archivo existente?`)) return;
    this.cloud.restoreSnapshotEntry(snapshot.id, entry.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (result) => this.announce(result.status === 'SKIPPED' ? 'El elemento se omitió según la estrategia seleccionada.' : `“${result.name ?? entry.name}” se restauró.`),
      error: () => this.fail('No se pudo restaurar el elemento.'),
    });
  }

  restoreSnapshot(snapshot: SnapshotRecord): void {
    if (!window.confirm(`Se restaurará “${snapshot.name}” como contenido nuevo en Drive. ¿Continuar?`)) return;
    this.cloud.restoreSnapshot(snapshot.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => { this.announce('Restauración en cola. El avance aparecerá en esta página.'); this.jobs.update((jobs) => [job, ...jobs.filter((item) => item.id !== job.id)]); },
      error: () => this.fail('No se pudo iniciar la restauración completa.'),
    });
  }

  deleteSnapshot(snapshot: SnapshotRecord): void {
    if (snapshot.isImmutable || !window.confirm(`¿Eliminar el punto de recuperación “${snapshot.name}”?`)) return;
    this.cloud.deleteSnapshot(snapshot.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { if (this.selected()?.id === snapshot.id) { this.selected.set(null); this.entries.set([]); } this.announce('Punto de recuperación eliminado.'); this.refresh(); },
      error: () => this.fail('No se pudo eliminar el snapshot.'),
    });
  }

  formatBytes(value: string | number): string {
    const bytes = Number(value);
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
  }

  statusLabel(status: SnapshotRestoreJobRecord['status']): string {
    return ({ QUEUED: 'En cola', RUNNING: 'Restaurando', COMPLETED: 'Completada', FAILED: 'Con errores', CANCELLED: 'Cancelada' } satisfies Record<SnapshotRestoreJobRecord['status'], string>)[status];
  }

  private announce(message: string): void { this.notice.set(message); this.error.set(null); }
  private fail(message: string): void { this.error.set(message); this.notice.set(null); }
}
