import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin, interval, startWith, switchMap } from 'rxjs';
import { CloudService } from '../../core/cloud/cloud.service';
import { BackupJobRecord, BackupPolicyRecord, CloudAccount, ProtectionAlertRecord, ProtectionOverviewRecord, SnapshotEntryRecord, SnapshotRecord, SnapshotRestoreJobRecord } from '../../shared/models/cloud.model';

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
  readonly backupPolicies = signal<BackupPolicyRecord[]>([]);
  readonly backups = signal<BackupJobRecord[]>([]);
  readonly accounts = signal<CloudAccount[]>([]);
  readonly alerts = signal<ProtectionAlertRecord[]>([]);
  readonly overview = signal<ProtectionOverviewRecord | null>(null);
  readonly selected = signal<SnapshotRecord | null>(null);
  readonly name = signal('');
  readonly description = signal('');
  readonly immutable = signal(true);
  readonly backupName = signal('');
  readonly backupDestination = signal('');
  readonly backupSchedule = signal<BackupPolicyRecord['schedule']>('DAILY');
  readonly backupRetentionDays = signal(30);
  readonly backupBusy = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  ngOnInit(): void {
    this.refresh();
    this.cloud.getAccounts().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (accounts) => { this.accounts.set(accounts); this.backupDestination.set(accounts.find((account) => account.status === 'CONNECTED')?.id ?? ''); },
      error: () => undefined,
    });
    this.cloud.listBackupPolicies().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (policies) => this.backupPolicies.set(policies), error: () => undefined });
    interval(5000).pipe(startWith(0), switchMap(() => forkJoin({
      restoreJobs: this.cloud.listSnapshotRestoreJobs(), backups: this.cloud.listBackups(),
      snapshots: this.cloud.listSnapshots(), alerts: this.cloud.listProtectionAlerts(), overview: this.cloud.getProtectionOverview(),
    })), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ restoreJobs, backups, snapshots, alerts, overview }) => { this.jobs.set(restoreJobs); this.backups.set(backups); this.snapshots.set(snapshots); this.alerts.set(alerts); this.overview.set(overview); },
      error: () => undefined,
    });
  }

  refresh(): void {
    this.cloud.listSnapshots().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (snapshots) => this.snapshots.set(snapshots),
      error: () => this.fail('No se pudieron cargar los snapshots.'),
    });
  }

  createBackupPolicy(): void {
    const name = this.backupName().trim();
    if (!name || !this.backupDestination()) { this.fail('Completa el nombre y elige una cuenta cloud conectada como destino.'); return; }
    this.backupBusy.set(true);
    this.cloud.createBackupPolicy({ name, destinationAccountId: this.backupDestination(), schedule: this.backupSchedule(), retentionDays: this.backupRetentionDays() }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (policy) => { this.backupBusy.set(false); this.backupName.set(''); this.backupPolicies.update((items) => [policy, ...items]); this.announce('Backup automático configurado.'); },
      error: () => { this.backupBusy.set(false); this.fail('No se pudo guardar la política de backup.'); },
    });
  }

  runBackup(policy: BackupPolicyRecord): void {
    this.cloud.runBackupPolicy(policy.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => { this.backups.update((items) => [job, ...items.filter((item) => item.id !== job.id)]); this.announce('Backup iniciado; verificará cada copia antes de marcarse como completado.'); },
      error: () => this.fail('No se pudo iniciar el backup.'),
    });
  }

  toggleBackupPolicy(policy: BackupPolicyRecord): void {
    this.cloud.updateBackupPolicy(policy.id, { enabled: !policy.enabled }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (updated) => this.backupPolicies.update((items) => items.map((item) => item.id === updated.id ? updated : item)),
      error: () => this.fail('No se pudo actualizar esta política.'),
    });
  }

  deleteBackupPolicy(policy: BackupPolicyRecord): void {
    if (!window.confirm(`¿Eliminar la programación “${policy.name}”? El historial de backups se conservará.`)) return;
    this.cloud.deleteBackupPolicy(policy.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.backupPolicies.update((items) => items.filter((item) => item.id !== policy.id)); this.announce('Programación eliminada; los backups guardados se conservarán.'); },
      error: () => this.fail('No se pudo eliminar la programación.'),
    });
  }

  restoreBackup(backup: BackupJobRecord): void {
    if (backup.status !== 'COMPLETED' || !window.confirm('Se recuperarán los archivos del backup y se añadirán al Drive. ¿Continuar?')) return;
    this.cloud.restoreBackup(backup.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => { this.jobs.update((items) => [job, ...items.filter((item) => item.id !== job.id)]); this.announce('Restauración del backup en cola.'); },
      error: () => this.fail('No se pudo restaurar el backup.'),
    });
  }

  resolveAlert(alert: ProtectionAlertRecord): void {
    this.cloud.resolveProtectionAlert(alert.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (resolved) => { this.alerts.update((items) => items.map((item) => item.id === resolved.id ? resolved : item)); this.announce('Alerta marcada como revisada.'); },
      error: () => this.fail('No se pudo actualizar la alerta.'),
    });
  }

  browseEmergencySnapshot(alert: ProtectionAlertRecord): void {
    const snapshot = this.snapshots().find((item) => item.id === alert.emergencySnapshotId);
    if (snapshot) this.browse(snapshot);
  }

  accountLabel(id: string): string {
    const account = this.accounts().find((item) => item.id === id);
    return account ? `${account.provider === 'GOOGLE_DRIVE' ? 'Google Drive' : 'OneDrive'}${account.displayName ? ` · ${account.displayName}` : ''}` : 'Cuenta no disponible';
  }

  hasConnectedAccount(): boolean { return this.accounts().some((account) => account.status === 'CONNECTED'); }

  backupStatus(status: BackupJobRecord['status']): string {
    return ({ QUEUED: 'En cola', PREPARING: 'Preparando', RUNNING: 'Copiando', VERIFYING: 'Verificando', COMPLETED: 'Verificado', FAILED: 'Falló', CANCELLED: 'Cancelado' } satisfies Record<BackupJobRecord['status'], string>)[status];
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
