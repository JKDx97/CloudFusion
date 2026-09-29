import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { API_TOKEN_SCOPES, ApiTokenRecord, ApiTokenScope, ApiTokensService } from '../../core/api-tokens/api-tokens.service';

@Component({
  selector: 'app-api-tokens',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './api-tokens.component.html',
})
export class ApiTokensComponent {
  private readonly apiTokens = inject(ApiTokensService);
  private readonly destroyRef = inject(DestroyRef);

  readonly availableScopes = API_TOKEN_SCOPES;
  readonly tokens = signal<ApiTokenRecord[]>([]);
  readonly oneTimeToken = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly loading = signal(true);
  readonly minExpirationDate = new Date().toISOString().slice(0, 10);
  name = '';
  selectedScopes: ApiTokenScope[] = ['files:read'];
  expirationDate = '';

  constructor() { this.load(); }

  load(): void {
    this.loading.set(true);
    this.apiTokens.list().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (items) => { this.tokens.set(items); this.loading.set(false); },
      error: () => { this.error.set('No se pudieron cargar los tokens de acceso.'); this.loading.set(false); },
    });
  }

  toggleScope(scope: ApiTokenScope, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.selectedScopes = checked
      ? [...new Set([...this.selectedScopes, scope])]
      : this.selectedScopes.filter((item) => item !== scope);
  }

  create(): void {
    this.error.set(null);
    this.notice.set(null);
    if (!this.name.trim()) { this.error.set('Escribe un nombre para identificar este token.'); return; }
    if (this.selectedScopes.length === 0) { this.error.set('Selecciona al menos un permiso.'); return; }
    const expiresAt = this.expirationDate ? new Date(`${this.expirationDate}T23:59:59`).toISOString() : undefined;
    this.apiTokens.create({ name: this.name.trim(), scopes: [...this.selectedScopes], ...(expiresAt ? { expiresAt } : {}) })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (created) => {
          this.oneTimeToken.set(created.token);
          this.name = '';
          this.selectedScopes = ['files:read'];
          this.expirationDate = '';
          this.notice.set('Token creado. Copia el secreto ahora: no volverá a mostrarse.');
          this.load();
        },
        error: () => this.error.set('No se pudo crear el token. Revisa los permisos elegidos e inténtalo de nuevo.'),
      });
  }

  async copyToken(): Promise<void> {
    const secret = this.oneTimeToken();
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      this.notice.set('Token copiado al portapapeles. Guárdalo en un lugar seguro.');
    } catch {
      this.error.set('El navegador no permitió copiarlo. Selecciona y copia el token manualmente.');
    }
  }

  dismissSecret(): void { this.oneTimeToken.set(null); }

  revoke(token: ApiTokenRecord): void {
    if (token.revokedAt || !window.confirm(`¿Revocar el token “${token.name}”? Las aplicaciones que lo usan perderán acceso.`)) return;
    this.apiTokens.revoke(token.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (updated) => {
        this.tokens.update((items) => items.map((item) => item.id === updated.id ? updated : item));
        this.notice.set(`El token “${token.name}” fue revocado.`);
      },
      error: () => this.error.set('No se pudo revocar el token.'),
    });
  }

  status(token: ApiTokenRecord): string {
    if (token.revokedAt) return 'Revocado';
    if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) return 'Expirado';
    return 'Activo';
  }

  formatDate(value: string | null): string {
    return value ? new Date(value).toLocaleString() : 'Nunca';
  }
}
