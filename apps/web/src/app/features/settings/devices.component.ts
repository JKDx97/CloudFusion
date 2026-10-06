import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { DesktopSyncBackgroundService } from '../../core/sync/desktop-sync-background.service';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api-response.model';

interface RegisteredDevice {
  id: string;
  name: string;
  platform: string;
  clientVersion: string | null;
  p2pEnabled: boolean;
  lanDiscoveryEnabled: boolean;
  internetP2pEnabled: boolean;
  relayAllowed: boolean;
  serveLocalFiles: boolean;
  storageContributionEnabled: boolean;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface DeviceStorageConfiguration {
  deviceId: string;
  enabled: boolean;
  maxBytes: string | null;
  usedBytes: string;
  availableBytes: string;
  storageClass: 'DEVICE_VOLATILE' | 'DEVICE_ALWAYS_ON' | null;
  availabilityStatus: 'ONLINE' | 'OFFLINE' | 'DISABLED';
  lastSeenAt: string | null;
}

interface DevicePairingCode {
  code: string;
  expiresAt: string;
}

interface GlobalP2pPrivacy {
  enabled: boolean;
}

type P2pSettingKey = 'p2pEnabled' | 'lanDiscoveryEnabled' | 'internetP2pEnabled' | 'relayAllowed' | 'serveLocalFiles';

interface P2pSetting {
  key: P2pSettingKey;
  label: string;
}

@Component({
  selector: 'app-devices',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './devices.component.html',
})
export class DevicesComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly syncCoordinator = inject(DesktopSyncBackgroundService);
  private readonly apiUrl = environment.apiUrl;
  private pairingExpiryTimer?: number;

  readonly devices = signal<RegisteredDevice[]>([]);
  readonly deviceStorage = signal<Record<string, DeviceStorageConfiguration>>({});
  readonly storageCapacityGiB = signal<Record<string, string>>({});
  readonly storageClass = signal<Record<string, 'DEVICE_VOLATILE' | 'DEVICE_ALWAYS_ON'>>({});
  readonly currentDeviceId = this.auth.deviceId;
  readonly pairingCode = signal<DevicePairingCode | null>(null);
  readonly loading = signal(true);
  readonly globalP2pEnabled = signal(true);
  readonly globalP2pLoaded = signal(false);
  readonly savingGlobalP2pPrivacy = signal(false);
  readonly creatingCode = signal(false);
  readonly revokingDevice = signal<string | null>(null);
  readonly savingDeviceSettings = signal<string | null>(null);
  readonly savingStorageSettings = signal<string | null>(null);
  readonly error = signal('');
  readonly notice = signal('');
  readonly p2pSettings: P2pSetting[] = [
    { key: 'p2pEnabled', label: 'P2P' },
    { key: 'lanDiscoveryEnabled', label: 'Descubrimiento LAN' },
    { key: 'internetP2pEnabled', label: 'P2P por Internet' },
    { key: 'relayAllowed', label: 'Permitir relay' },
    { key: 'serveLocalFiles', label: 'Servir archivos locales' },
  ];

  ngOnInit(): void {
    void this.loadDevices();
  }

  ngOnDestroy(): void {
    if (this.pairingExpiryTimer !== undefined) window.clearTimeout(this.pairingExpiryTimer);
  }

  async loadDevices(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const [response, privacy] = await Promise.all([
        firstValueFrom(this.http.get<ApiResponse<RegisteredDevice[]>>(`${this.apiUrl}/devices`)),
        firstValueFrom(this.http.get<ApiResponse<GlobalP2pPrivacy>>(`${this.apiUrl}/p2p/privacy`)),
      ]);
      this.devices.set(response.data);
      this.globalP2pEnabled.set(privacy.data.enabled);
      this.globalP2pLoaded.set(true);
      await this.syncCoordinator.updateGlobalP2pPrivacy(privacy.data.enabled);
      const activeDevices = response.data.filter((device) => !device.revokedAt);
      const storageResults = await Promise.all(activeDevices.map(async (device) => {
        try {
          const result = await firstValueFrom(this.http.get<ApiResponse<DeviceStorageConfiguration>>(
            `${this.apiUrl}/devices/${device.id}/storage`,
          ));
          return result.data;
        } catch {
          return null;
        }
      }));
      const storage = Object.fromEntries(storageResults.filter((item): item is DeviceStorageConfiguration => item !== null)
        .map((item) => [item.deviceId, item]));
      this.deviceStorage.set(storage);
      this.storageCapacityGiB.set(Object.fromEntries(Object.values(storage).map((item) => [
        item.deviceId,
        item.maxBytes ? (Number(item.maxBytes) / 1_073_741_824).toFixed(3) : '',
      ])));
      this.storageClass.set(Object.fromEntries(Object.values(storage).map((item) => [
        item.deviceId,
        item.storageClass ?? 'DEVICE_VOLATILE',
      ])));
    } catch {
      this.globalP2pLoaded.set(false);
      this.error.set('No se pudieron cargar tus dispositivos. Inténtalo de nuevo.');
    } finally {
      this.loading.set(false);
    }
  }

  async updateGlobalP2pPrivacy(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const enabled = input.checked;
    if (this.savingGlobalP2pPrivacy()) return;
    if (!enabled && !window.confirm('Desactivar P2P en toda tu cuenta? Se retirarán los anuncios y se cancelarán las transferencias P2P activas. Las descargas normales desde la nube seguirán disponibles.')) {
      input.checked = this.globalP2pEnabled();
      return;
    }

    this.savingGlobalP2pPrivacy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      const response = await firstValueFrom(this.http.patch<ApiResponse<GlobalP2pPrivacy>>(
        `${this.apiUrl}/p2p/privacy`,
        { enabled },
      ));
      this.globalP2pEnabled.set(response.data.enabled);
      await this.syncCoordinator.updateGlobalP2pPrivacy(response.data.enabled);
      this.notice.set(enabled
        ? 'P2P se volvió a habilitar para la cuenta. Cada dispositivo conserva sus preferencias individuales.'
        : 'P2P está desactivado para toda la cuenta. Las descargas desde la nube siguen funcionando.');
    } catch {
      input.checked = this.globalP2pEnabled();
      this.error.set('No se pudo cambiar la privacidad P2P. No se aplicaron cambios; inténtalo de nuevo.');
    } finally {
      this.savingGlobalP2pPrivacy.set(false);
    }
  }

  async createPairingCode(): Promise<void> {
    if (this.creatingCode()) return;
    this.creatingCode.set(true);
    this.error.set('');
    this.notice.set('');
    if (this.pairingExpiryTimer !== undefined) window.clearTimeout(this.pairingExpiryTimer);
    this.pairingCode.set(null);
    try {
      const response = await firstValueFrom(
        this.http.post<ApiResponse<DevicePairingCode>>(`${this.apiUrl}/auth/device-pairing-codes`, {}),
      );
      this.pairingCode.set(response.data);
      const expiresInMs = Math.max(0, Date.parse(response.data.expiresAt) - Date.now());
      this.pairingExpiryTimer = window.setTimeout(() => {
        if (this.pairingCode()?.code === response.data.code) {
          this.pairingCode.set(null);
          this.notice.set('El código temporal expiró. Genera uno nuevo para emparejar el dispositivo.');
        }
      }, expiresInMs);
    } catch {
      this.error.set('No se pudo generar el código. Inicia sesión de nuevo e inténtalo otra vez.');
    } finally {
      this.creatingCode.set(false);
    }
  }

  async copyPairingCode(): Promise<void> {
    const code = this.pairingCode()?.code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      this.notice.set('Código copiado. Caduca a los cinco minutos; úsalo solo en el NAS que estás emparejando.');
    } catch {
      this.notice.set('No se pudo copiar automáticamente. Selecciona el código y cópialo manualmente.');
    }
  }

  async revoke(device: RegisteredDevice): Promise<void> {
    if (!device.id || device.id === this.auth.deviceId || device.revokedAt || this.revokingDevice()) return;
    const confirmed = window.confirm(`¿Revocar el acceso de “${device.name}”? Ese dispositivo dejará de acceder a CloudFusion.`);
    if (!confirmed) return;

    this.revokingDevice.set(device.id);
    this.error.set('');
    this.notice.set('');
    try {
      await firstValueFrom(this.http.post<ApiResponse<{ revoked: true }>>(
        `${this.apiUrl}/devices/${device.id}/revoke`,
        {},
      ));
      this.notice.set(`Se revocó el acceso de ${device.name}.`);
      await this.loadDevices();
    } catch {
      this.error.set('No se pudo revocar el dispositivo. Actualiza la lista e inténtalo de nuevo.');
    } finally {
      this.revokingDevice.set(null);
    }
  }

  async toggleP2pSetting(device: RegisteredDevice, key: P2pSettingKey): Promise<void> {
    if (device.revokedAt || this.savingDeviceSettings()) return;
    this.savingDeviceSettings.set(device.id);
    this.error.set('');
    this.notice.set('');
    try {
      const response = await firstValueFrom(this.http.patch<ApiResponse<RegisteredDevice>>(
        `${this.apiUrl}/devices/${device.id}/settings`,
        { [key]: !device[key] },
      ));
      this.devices.update((devices) => devices.map((item) => item.id === device.id ? response.data : item));
      this.notice.set(`Se actualizó la configuración de red de ${device.name}.`);
    } catch {
      this.error.set(`No se pudo actualizar la configuración de ${device.name}. Inténtalo de nuevo.`);
    } finally {
      this.savingDeviceSettings.set(null);
    }
  }

  setStorageCapacity(deviceId: string, value: string): void {
    this.storageCapacityGiB.update((current) => ({ ...current, [deviceId]: value }));
  }

  setStorageClass(deviceId: string, value: string): void {
    if (value !== 'DEVICE_VOLATILE' && value !== 'DEVICE_ALWAYS_ON') return;
    this.storageClass.update((current) => ({ ...current, [deviceId]: value }));
  }

  async saveStorageSettings(device: RegisteredDevice, enabled: boolean): Promise<void> {
    if (device.revokedAt || this.savingStorageSettings()) return;
    const input = this.storageCapacityGiB()[device.id] ?? '';
    const parsedMaxBytes = input.trim() ? this.gibiBytes(input) : null;
    if (enabled && !parsedMaxBytes) {
      this.error.set('Indica una capacidad válida en GiB (por ejemplo, 20 o 20.5).');
      return;
    }
    const maxBytes = parsedMaxBytes ?? (enabled ? null : this.deviceStorage()[device.id]?.maxBytes ?? null);

    this.savingStorageSettings.set(device.id);
    this.error.set('');
    this.notice.set('');
    try {
      const response = await firstValueFrom(this.http.patch<ApiResponse<DeviceStorageConfiguration>>(
        `${this.apiUrl}/devices/${device.id}/storage`,
        {
          enabled,
          ...(maxBytes ? { maxBytes } : {}),
          storageClass: this.storageClass()[device.id] ?? 'DEVICE_VOLATILE',
        },
      ));
      this.deviceStorage.update((current) => ({ ...current, [device.id]: response.data }));
      this.notice.set(enabled
        ? `Almacenamiento configurado para ${device.name}. Se mostrará disponible cuando el dispositivo envíe su heartbeat.`
        : `Aporte de almacenamiento desactivado para ${device.name}.`);
      await this.loadDevices();
    } catch {
      this.error.set(`No se pudo guardar el almacenamiento de ${device.name}. Revisa la capacidad y vuelve a intentarlo.`);
    } finally {
      this.savingStorageSettings.set(null);
    }
  }

  storageStatusLabel(deviceId: string): string {
    const status = this.deviceStorage()[deviceId]?.availabilityStatus;
    if (status === 'ONLINE') return 'En línea';
    if (status === 'OFFLINE') return 'Sin heartbeat';
    if (status === 'DISABLED') return 'Desactivado';
    return 'No disponible';
  }

  formatBytes(value: string): string {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  private gibiBytes(value: string): string | null {
    const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
    if (!match) return null;
    try {
      const whole = BigInt(match[1]);
      const fraction = BigInt((match[2] ?? '').padEnd(3, '0') || '0');
      const thousandths = whole * 1000n + fraction;
      const bytes = (thousandths * 1_073_741_824n + 500n) / 1000n;
      return bytes > 0n && bytes <= 9_223_372_036_854_775_807n ? bytes.toString() : null;
    } catch {
      return null;
    }
  }
}
