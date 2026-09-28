import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CloudService } from '../../core/cloud/cloud.service';
import { CloudAccount, StorageRule, StorageRuleConditionType } from '../../shared/models/cloud.model';

@Component({ selector: 'app-rules', standalone: true, imports: [FormsModule, RouterLink], templateUrl: './rules.component.html' })
export class RulesComponent {
  private readonly cloud = inject(CloudService);
  private readonly destroyRef = inject(DestroyRef);
  readonly rules = signal<StorageRule[]>([]);
  readonly accounts = signal<CloudAccount[]>([]);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  name = ''; priority = 10; enabled = true; conditionType: StorageRuleConditionType = 'DEFAULT'; conditionValue = ''; destinationAccountId = ''; editingId: string | null = null;
  readonly conditionTypes: { key: StorageRuleConditionType; label: string }[] = [{ key: 'EXTENSION', label: 'Extensión' }, { key: 'MIME', label: 'MIME' }, { key: 'SIZE_GREATER_THAN', label: 'Tamaño mayor que (bytes)' }, { key: 'DEFAULT', label: 'Por defecto' }];

  constructor() { this.load(); }
  load(): void { this.cloud.getAccounts().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (items) => { this.accounts.set(items.filter((item) => item.status === 'CONNECTED')); if (!this.destinationAccountId) this.destinationAccountId = this.accounts()[0]?.id ?? ''; } }); this.cloud.listRules().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (items) => this.rules.set(items), error: () => this.error.set('No se pudieron cargar las reglas.') }); }
  save(): void {
    if (!this.name.trim() || !this.destinationAccountId) { this.error.set('Completa nombre y cuenta destino.'); return; }
    const payload = { name: this.name.trim(), priority: Number(this.priority), enabled: this.enabled, conditionType: this.conditionType, conditionValue: this.conditionValue.trim() || undefined, destinationAccountId: this.destinationAccountId };
    const request = this.editingId ? this.cloud.updateRule(this.editingId, payload) : this.cloud.createRule(payload);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.notice.set(this.editingId ? 'Regla actualizada.' : 'Regla creada.'); this.reset(); this.load(); }, error: () => this.error.set('No se pudo guardar la regla.') });
  }
  edit(rule: StorageRule): void { this.editingId = rule.id; this.name = rule.name; this.priority = rule.priority; this.enabled = rule.enabled; this.conditionType = rule.conditionType; this.conditionValue = rule.conditionValue ?? ''; this.destinationAccountId = rule.destinationAccountId; }
  toggle(rule: StorageRule): void { this.cloud.updateRule(rule.id, { enabled: !rule.enabled }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (updated) => this.rules.update((items) => items.map((item) => item.id === updated.id ? updated : item)), error: () => this.error.set('No se pudo cambiar el estado.') }); }
  remove(rule: StorageRule): void { if (!window.confirm(`¿Eliminar ${rule.name}?`)) return; this.cloud.deleteRule(rule.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => this.rules.update((items) => items.filter((item) => item.id !== rule.id)), error: () => this.error.set('No se pudo eliminar la regla.') }); }
  reset(): void { this.editingId = null; this.name = ''; this.priority = 10; this.enabled = true; this.conditionType = 'DEFAULT'; this.conditionValue = ''; }
  accountLabel(id: string): string { const account = this.accounts().find((item) => item.id === id); return account ? `${account.provider === 'GOOGLE_DRIVE' ? 'Google Drive' : 'OneDrive'}${account.email ? ` · ${account.email}` : ''}` : 'Cuenta no disponible'; }
}
