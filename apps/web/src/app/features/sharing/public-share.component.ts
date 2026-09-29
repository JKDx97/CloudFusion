import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CloudService } from '../../core/cloud/cloud.service';
import { PublicShareInfo } from '../../shared/models/cloud.model';

@Component({
  standalone: true,
  imports: [CommonModule, DatePipe],
  selector: 'app-public-share',
  templateUrl: './public-share.component.html',
})
export class PublicShareComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly cloud = inject(CloudService);
  private readonly destroyRef = inject(DestroyRef);
  private token = '';

  readonly info = signal<PublicShareInfo | null>(null);
  readonly password = signal('');
  readonly loading = signal(true);
  readonly downloading = signal(false);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.token = this.route.snapshot.paramMap.get('token') ?? '';
    if (!this.token) { this.fail(); return; }
    this.cloud.getPublicShare(this.token).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (info) => { this.info.set(info); this.loading.set(false); },
      error: () => this.fail(),
    });
  }

  unlock(): void {
    if (!this.token || !this.password()) { this.error.set('Escribe la contraseña del enlace.'); return; }
    this.loading.set(true);
    this.error.set(null);
    this.cloud.accessPublicShare(this.token, this.password()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (info) => { this.info.set(info); this.loading.set(false); },
      error: () => { this.loading.set(false); this.error.set('El enlace o la contraseña no son válidos.'); },
    });
  }

  download(): void {
    if (!this.token || this.info()?.permission !== 'DOWNLOAD') return;
    this.downloading.set(true);
    this.error.set(null);
    this.cloud.downloadPublicShare(this.token, this.password() || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = this.info()?.resource?.name ?? 'archivo';
        anchor.click();
        URL.revokeObjectURL(url);
        this.downloading.set(false);
      },
      error: () => { this.downloading.set(false); this.error.set('No se pudo descargar; el enlace puede haber vencido o alcanzado su límite.'); },
    });
  }

  formatBytes(value: number | null | undefined): string {
    if (!value) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
  }

  private fail(): void {
    this.loading.set(false);
    this.error.set('Este enlace no existe, venció o fue desactivado.');
  }
}
