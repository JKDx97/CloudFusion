import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CloudService } from '../../core/cloud/cloud.service';
import { CloudAccount, CloudProvider, ConnectS3AccountInput, ProviderConnectionTestResult, ProviderDescriptor, StorageTargetRecord } from '../../shared/models/cloud.model';

const S3_PROVIDERS: CloudProvider[] = [
  'AWS_S3', 'CLOUDFLARE_R2', 'WASABI', 'BACKBLAZE_B2',
  'DIGITALOCEAN_SPACES', 'ORACLE_OBJECT_STORAGE', 'IBM_COS', 'CUSTOM_S3',
];

@Component({
  selector: 'app-providers',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './providers.component.html',
})
export class ProvidersComponent implements OnInit {
  private readonly cloud = inject(CloudService);
  private readonly destroyRef = inject(DestroyRef);

  readonly catalog = signal<ProviderDescriptor[]>([]);
  readonly accounts = signal<CloudAccount[]>([]);
  readonly targets = signal<StorageTargetRecord[]>([]);
  readonly s3Accounts = computed(() => this.accounts().filter((account) =>
    account.credentialType === 'ACCESS_KEY' && S3_PROVIDERS.includes(account.provider),
  ));
  readonly providerOptions = computed(() => this.catalog().filter((provider) =>
    S3_PROVIDERS.includes(provider.id) && provider.supportStatus !== 'UNAVAILABLE',
  ));
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly testing = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly connectionHealth = signal<ProviderConnectionTestResult | null>(null);

  provider: CloudProvider = 'AWS_S3';
  accountName = '';
  bucket = '';
  region = 'us-east-1';
  endpoint = '';
  prefix = '';
  accessKeyId = '';
  secretAccessKey = '';
  sessionToken = '';
  verifyWrite = false;

  targetAccountId = '';
  targetBucket = '';
  targetName = '';
  targetRegion = 'us-east-1';
  targetEndpoint = '';
  targetPrefix = '';
  targetVerifyWrite = false;

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.cloud.getProviders().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (providers) => { this.catalog.set(providers); this.loading.set(false); },
      error: () => { this.error.set('No se pudo cargar el catálogo de proveedores.'); this.loading.set(false); },
    });
    this.cloud.getAccounts().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (accounts) => {
        this.accounts.set(accounts);
        if (!this.targetAccountId || !accounts.some((account) => account.id === this.targetAccountId)) {
          this.targetAccountId = accounts.find((account) => account.credentialType === 'ACCESS_KEY' && S3_PROVIDERS.includes(account.provider))?.id ?? '';
        }
        if (this.targetAccountId) this.loadTargets(this.targetAccountId);
      },
      error: () => this.error.set('No se pudieron cargar tus cuentas conectadas.'),
    });
  }

  selectProvider(value: string): void {
    if (!S3_PROVIDERS.includes(value as CloudProvider)) return;
    this.provider = value as CloudProvider;
    this.region = this.provider === 'CLOUDFLARE_R2' ? 'auto' : 'us-east-1';
    this.endpoint = '';
  }

  needsEndpoint(provider: CloudProvider): boolean { return provider !== 'AWS_S3'; }

  testConnection(): void {
    const input = this.connectionInput();
    if (!input) return;
    this.error.set(null);
    this.notice.set(null);
    this.testing.set(true);
    this.cloud.testS3Connection(input).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (health) => {
        this.connectionHealth.set(health);
        this.testing.set(false);
        if (health.success && health.read) {
          this.notice.set(health.write === true
            ? 'La conexión y la escritura se verificaron correctamente.'
            : 'La lectura del bucket funciona. La escritura no se probó.');
        } else {
          this.error.set(this.healthMessage(health));
        }
      },
      error: () => { this.testing.set(false); this.error.set('No se pudo conectar. Revisa región, endpoint, permisos y credenciales.'); },
    });
  }

  connectAccount(): void {
    const input = this.connectionInput();
    if (!input) return;
    this.error.set(null);
    this.notice.set(null);
    this.busy.set(true);
    this.cloud.connectS3Account(input).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (result) => {
        this.accounts.update((items) => [...items.filter((account) => account.id !== result.account.id), result.account]);
        this.targetAccountId = result.account.id;
        this.targets.set([result.target]);
        this.connectionHealth.set(result.health);
        this.busy.set(false);
        this.notice.set(result.health.write === true
          ? `${result.account.displayName ?? 'La cuenta'} se conectó; lectura y escritura verificadas.`
          : `${result.account.displayName ?? 'La cuenta'} se conectó. La lectura funciona; la escritura no se probó.`);
        this.clearCredentials();
        this.bucket = '';
        this.accessKeyId = '';
      },
      error: () => { this.busy.set(false); this.error.set('No se pudo guardar la cuenta. Verifica que el bucket permita lectura y que el servidor tenga la clave de cifrado configurada.'); },
    });
  }

  addTarget(): void {
    const accountId = this.targetAccountId;
    if (!accountId || !this.targetBucket.trim() || !this.targetRegion.trim()) {
      this.error.set('Selecciona una cuenta e indica el bucket y la región.');
      return;
    }
    this.error.set(null);
    this.notice.set(null);
    this.busy.set(true);
    this.cloud.addStorageTarget(accountId, {
      bucket: this.targetBucket.trim(),
      region: this.targetRegion.trim(),
      ...(this.targetEndpoint.trim() ? { endpoint: this.targetEndpoint.trim() } : {}),
      ...(this.targetPrefix.trim() ? { prefix: this.targetPrefix.trim() } : {}),
      ...(this.targetName.trim() ? { name: this.targetName.trim() } : {}),
      verifyWrite: this.targetVerifyWrite,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ target, health }) => {
        this.targets.update((items) => [...items.filter((item) => item.id !== target.id), target]);
        this.targetBucket = '';
        this.targetName = '';
        this.busy.set(false);
        this.notice.set(health.write === true ? 'Destino agregado; lectura y escritura verificadas.' : 'Destino agregado. La lectura funciona; la escritura no se probó.');
      },
      error: () => { this.busy.set(false); this.error.set('No se pudo agregar el destino. Comprueba su endpoint y permisos.'); },
    });
  }

  selectTargetAccount(accountId: string): void {
    this.targetAccountId = accountId;
    const account = this.s3Accounts().find((item) => item.id === accountId);
    this.targetRegion = account?.provider === 'CLOUDFLARE_R2' ? 'auto' : 'us-east-1';
    this.targetEndpoint = '';
    this.loadTargets(accountId);
  }

  checkTarget(target: StorageTargetRecord): void {
    this.error.set(null);
    this.cloud.testStorageTarget(target.cloudAccountId, target.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (health) => {
        if (health.success && health.read) this.notice.set(`“${target.name}”: lectura correcta (${health.latencyMs} ms).`);
        else this.error.set(this.healthMessage(health));
      },
      error: () => this.error.set('No se pudo comprobar este destino.'),
    });
  }

  categoryLabel(category: ProviderDescriptor['category']): string {
    return ({ CONSUMER_DRIVE: 'Nube personal', OBJECT_STORAGE: 'Almacenamiento de objetos', SELF_HOSTED: 'Autohospedado', EXPERIMENTAL: 'Experimental' })[category];
  }

  supportLabel(status: ProviderDescriptor['supportStatus']): string {
    return ({ STABLE: 'Estable', BETA: 'Beta', EXPERIMENTAL: 'Experimental', COMING_SOON: 'Próximamente', UNAVAILABLE: 'No disponible' })[status];
  }

  capabilityLabels(provider: ProviderDescriptor): string[] {
    const labels: Partial<Record<keyof ProviderDescriptor['capabilities'], string>> = {
      list: 'Listar', copy: 'Copiar', multipartUpload: 'Carga multiparte', resumableUpload: 'Reanudar cargas', rangeDownload: 'Descarga parcial', serverSideCopy: 'Copia en proveedor',
    };
    return Object.entries(provider.capabilities).flatMap(([key, supported]) => supported && labels[key as keyof typeof labels] ? [labels[key as keyof typeof labels] as string] : []);
  }

  private connectionInput(): ConnectS3AccountInput | null {
    if (!this.bucket.trim() || !this.region.trim() || !this.accessKeyId.trim() || !this.secretAccessKey) {
      this.error.set('Completa el bucket, la región y ambas claves de acceso.');
      return null;
    }
    if (this.needsEndpoint(this.provider) && !this.endpoint.trim()) {
      this.error.set('Este proveedor requiere su endpoint S3 compatible.');
      return null;
    }
    return {
      provider: this.provider,
      bucket: this.bucket.trim(),
      region: this.region.trim(),
      accessKeyId: this.accessKeyId.trim(),
      secretAccessKey: this.secretAccessKey,
      ...(this.accountName.trim() ? { accountName: this.accountName.trim() } : {}),
      ...(this.endpoint.trim() ? { endpoint: this.endpoint.trim() } : {}),
      ...(this.prefix.trim() ? { prefix: this.prefix.trim() } : {}),
      ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
      verifyWrite: this.verifyWrite,
    };
  }

  private loadTargets(accountId: string): void {
    this.cloud.getStorageTargets(accountId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (items) => this.targets.set(items),
      error: () => this.error.set('No se pudieron cargar los destinos de esta cuenta.'),
    });
  }

  private clearCredentials(): void {
    this.secretAccessKey = '';
    this.sessionToken = '';
  }

  private healthMessage(health: ProviderConnectionTestResult): string {
    if (health.errorCode === 'PROVIDER_AUTH_FAILED') return 'El proveedor rechazó las credenciales.';
    if (health.errorCode === 'PROVIDER_PERMISSION_DENIED') return 'La clave no tiene permiso para consultar el bucket.';
    if (health.errorCode === 'PROVIDER_TARGET_NOT_FOUND') return 'No se encontró el bucket indicado.';
    return 'No se pudo validar la lectura del bucket. Comprueba endpoint, región y permisos.';
  }
}
