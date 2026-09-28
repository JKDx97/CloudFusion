import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CloudService } from '../../core/cloud/cloud.service';
import { CloudFile, CloudProvider } from '../../shared/models/cloud.model';

@Component({ selector: 'app-search', standalone: true, imports: [RouterLink], templateUrl: './search.component.html' })
export class SearchComponent {
  private readonly cloud = inject(CloudService);
  private readonly destroyRef = inject(DestroyRef);
  readonly query = signal('');
  readonly results = signal<CloudFile[]>([]);
  readonly failures = signal<{ accountId: string; provider: CloudProvider; message: string }[]>([]);
  readonly loading = signal(false);
  readonly searched = signal(false);
  readonly error = signal<string | null>(null);

  run(): void {
    const query = this.query().trim();
    if (!query) return;
    this.loading.set(true); this.error.set(null); this.searched.set(true);
    this.cloud.search(query).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (response) => { this.results.set(response.results); this.failures.set(response.failures); this.loading.set(false); }, error: () => { this.error.set('No se pudo ejecutar la búsqueda.'); this.loading.set(false); } });
  }

  providerLabel(provider: CloudProvider): string { return provider === 'GOOGLE_DRIVE' ? 'Google Drive' : 'OneDrive'; }
  formatBytes(value?: number): string { if (!value) return '—'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`; }
  open(file: CloudFile): void { if (file.webUrl) window.open(file.webUrl, '_blank', 'noopener'); }
  download(file: CloudFile): void { this.cloud.download(file.accountId, file.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (blob) => { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click(); URL.revokeObjectURL(url); } }); }
}
