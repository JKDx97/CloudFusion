import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
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

interface DevicePairingCode {
  code: string;
  expiresAt: string;
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
  private readonly apiUrl = environment.apiUrl;
  private pairingExpiryTimer?: number;

  readonly devices = signal<RegisteredDevice[]>([]);
  readonly currentDeviceId = this.auth.deviceId;
  readonly pairingCode = signal<DevicePairingCode | null>(null);
  readonly loading = signal(true);
  readonly creatingCode = signal(false);
  readonly revokingDevice = signal<string | null>(null);
  readonly savingDeviceSettings = signal<string | null>(null);
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
      const response = await firstValueFrom(
        this.http.get<ApiResponse<RegisteredDevice[]>>(`${this.apiUrl}/devices`),
      );
      this.devices.set(response.data);
    } catch {
      this.error.set('No se pudieron cargar tus dispositivos. Inténtalo de nuevo.');
    } finally {
      this.loading.set(false);
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
}
