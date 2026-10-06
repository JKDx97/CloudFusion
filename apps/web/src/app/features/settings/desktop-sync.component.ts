import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { DesktopSyncBackgroundService, DesktopSyncChange as SyncChange, DesktopSyncRoot as SyncRoot } from '../../core/sync/desktop-sync-background.service';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api-response.model';

interface DesktopDeviceRegistration {
  installationId: string;
  name: string;
  platform: string;
  clientVersion: string;
}

interface DeviceStorageRoot {
  path: string;
}

interface RemoteFolder {
  id: string;
  name: string;
  type: 'FILE' | 'FOLDER';
  parentId: string | null;
  isRoot: boolean;
}

interface RegisteredDevice {
  id: string;
  p2pEnabled: boolean;
  lanDiscoveryEnabled: boolean;
  internetP2pEnabled: boolean;
  relayAllowed: boolean;
  serveLocalFiles: boolean;
}

interface MeshPeer {
  id: string;
  name: string;
  platform: string;
  peerId: string;
  peerPublicKey: string;
  lastSeenAt: string | null;
}

interface MeshPeerUpdate {
  peerId: string;
  status: string;
  multiaddr: string | null;
}

interface DesktopBridge extends Window {
  __TAURI__?: {
    core?: {
      invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    };
    event?: {
      listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
    };
  };
}

@Component({
  selector: 'app-desktop-sync',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './desktop-sync.component.html',
})
export class DesktopSyncComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly syncCoordinator = inject(DesktopSyncBackgroundService);
  private readonly apiUrl = environment.apiUrl;
  readonly desktopAvailable = this.bridgeAvailable();
  readonly device = signal<DesktopDeviceRegistration | null>(null);
  readonly deviceStorageRoot = signal<DeviceStorageRoot | null>(null);
  readonly roots = this.syncCoordinator.roots;
  readonly changes = this.syncCoordinator.changes;
  readonly remoteFolders = signal<Array<{ id: string; label: string }>>([]);
  readonly destinationsBusy = signal(false);
  readonly initialSyncBusy = signal<Record<string, boolean>>({});
  readonly syncStates = this.syncCoordinator.syncStates;
  readonly syncNotice = this.syncCoordinator.syncNotice;
  readonly indexedFileCount = signal<number | null>(null);
  readonly indexingBusy = signal(false);
  readonly indexNotice = signal<string | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly meshEnabled = signal(false);
  readonly globalP2pEnabled = signal(true);
  readonly lanDiscoveryEnabled = signal(false);
  readonly internetP2pEnabled = signal(false);
  readonly relayAllowed = signal(true);
  readonly serveLocalFiles = signal(false);
  readonly meshBusy = signal(false);
  readonly meshPeers = signal<MeshPeer[]>([]);
  readonly meshPeerStatuses = signal<Record<string, string>>({});
  readonly meshStatus = signal('Desactivada');
  private stopMeshListening?: () => void;
  private stopStatusListening?: () => void;

  ngOnInit(): void {
    if (!this.desktopAvailable) return;
    this.syncCoordinator.start();
    void this.load();
    const events = (window as DesktopBridge).__TAURI__?.event;
    if (!events) return;
    void events.listen<MeshPeerUpdate>('mesh-peer-update', ({ payload }) => {
      this.meshPeerStatuses.update((statuses) => ({ ...statuses, [payload.peerId]: payload.status }));
    }).then((stop) => (this.stopMeshListening = stop));
    void events.listen<string>('mesh-status', ({ payload }) => this.meshStatus.set(payload))
      .then((stop) => (this.stopStatusListening = stop));
  }

  ngOnDestroy(): void {
    this.stopMeshListening?.();
    this.stopStatusListening?.();
  }

  async load(): Promise<void> {
    try {
      const device = await this.invoke<DesktopDeviceRegistration>('get_device_registration');
      await this.syncCoordinator.refresh();
      this.device.set(device);
      this.deviceStorageRoot.set(await this.invoke<DeviceStorageRoot | null>('get_device_storage_root'));
      this.error.set(null);
      await this.loadMeshConfiguration();
      try {
        await this.loadRemoteFolders();
      } catch {
        this.syncNotice.set('No se pudieron cargar las carpetas de Mi Drive. Comprueba tu conexión y vuelve a actualizar.');
      }
    } catch {
      this.error.set('No se pudo cargar la configuración local de CloudFusion.');
    }
  }

  async chooseFolder(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const path = await this.invoke<string | null>('choose_sync_folder');
      if (path) {
        const root = await this.invoke<SyncRoot>('add_sync_root', { path });
        this.syncCoordinator.setRoots([...this.roots(), root]);
      }
    } catch (error) {
      this.error.set(typeof error === 'string' ? error : 'No se pudo agregar la carpeta.');
    } finally {
      this.busy.set(false);
    }
  }

  async chooseDeviceStorageFolder(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const path = await this.invoke<string | null>('choose_device_storage_folder');
      if (!path) return;
      this.deviceStorageRoot.set(await this.invoke<DeviceStorageRoot>('set_device_storage_root', { path }));
      this.syncNotice.set('Carpeta dedicada configurada. CloudFusion la usará solo para réplicas locales; la ruta no se envía al servidor.');
    } catch (error) {
      this.error.set(this.nativeError(error, 'No se pudo configurar la carpeta dedicada de almacenamiento.'));
    } finally {
      this.busy.set(false);
    }
  }

  async updateSyncDestination(root: SyncRoot, event: Event): Promise<void> {
    const remoteNodeId = (event.target as HTMLSelectElement).value || null;
    try {
      const updated = await this.invoke<SyncRoot>('set_sync_destination', {
        rootId: root.id,
        remoteNodeId,
      });
      const nextRoots = this.roots().map((item) => item.id === updated.id ? updated : item);
      this.syncCoordinator.setRoots(nextRoots);
      this.syncNotice.set(remoteNodeId
        ? 'Destino guardado. Los cambios nuevos se subirán automáticamente; usa “Sincronizar ahora” para enviar los archivos que ya existían.'
        : 'Sincronización con la nube pausada para esta carpeta local.');
    } catch (error) {
      this.error.set(this.nativeError(error, 'No se pudo guardar la carpeta de destino.'));
    }
  }

  async syncExistingFiles(root: SyncRoot): Promise<void> {
    if (!root.remoteNodeId) {
      this.syncNotice.set('Primero elige una carpeta de destino en Mi Drive.');
      return;
    }
    this.initialSyncBusy.update((busy) => ({ ...busy, [root.id]: true }));
    this.syncNotice.set(`Buscando archivos dentro de ${root.path}…`);
    try {
      const files = await this.invoke<string[]>('list_sync_files', { rootId: root.id });
      let completed = 0;
      let failed = 0;
      for (const relativePath of files) {
        const synchronized = await this.syncCoordinator.syncFile(root.id, relativePath);
        if (synchronized) completed += 1;
        else failed += 1;
        this.syncNotice.set(`Sincronizando archivos existentes: ${completed + failed} de ${files.length}…`);
      }
      this.syncNotice.set(files.length
        ? failed
          ? `Se sincronizaron ${completed} de ${files.length} archivos. ${failed} quedaron pendientes; revisa los cambios para reintentarlos.`
          : `Listo: se sincronizaron ${completed} archivos con Mi Drive.`
        : 'La carpeta local no contiene archivos para sincronizar.');
    } catch (error) {
      this.syncNotice.set(this.nativeError(error, 'No se pudo completar la sincronización inicial.'));
    } finally {
      this.initialSyncBusy.update((busy) => ({ ...busy, [root.id]: false }));
    }
  }

  async retryChange(change: SyncChange): Promise<void> {
    await this.syncCoordinator.retryChange(change);
  }

  canRetry(change: SyncChange): boolean {
    return this.syncCoordinator.canRetry(change);
  }

  async removeFolder(root: SyncRoot): Promise<void> {
    try {
      await this.invoke<void>('remove_sync_root', { id: root.id });
      this.syncCoordinator.setRoots(this.roots().filter((item) => item.id !== root.id));
    } catch {
      this.error.set('No se pudo quitar la carpeta de este dispositivo.');
    }
  }

  async indexLocalFiles(): Promise<void> {
    if (!this.roots().length) {
      this.indexNotice.set('Primero elige una carpeta para sincronizar.');
      return;
    }
    this.indexingBusy.set(true);
    this.indexNotice.set(null);
    try {
      const fileCount = await this.invoke<number>('index_sync_files');
      this.indexedFileCount.set(fileCount);
      this.indexNotice.set(fileCount
        ? `${fileCount} copias locales analizadas. Las rutas y huellas permanecen en este dispositivo; no se anuncian al servidor.`
        : 'No se encontraron archivos regulares en las carpetas observadas.');
    } catch (error) {
      this.indexedFileCount.set(null);
      this.indexNotice.set(typeof error === 'string' ? error : 'No se pudieron analizar las copias locales.');
    } finally {
      this.indexingBusy.set(false);
    }
  }

  async updateMeshSetting(event: Event, setting: 'lanDiscoveryEnabled' | 'internetP2pEnabled' | 'relayAllowed'): Promise<void> {
    const deviceId = this.authService.deviceId;
    if (!deviceId) {
      this.error.set('La sesión Desktop no incluye un dispositivo registrado. Cierra sesión e inicia de nuevo.');
      return;
    }
    const value = (event.target as HTMLInputElement).checked;
    const next = {
      lanDiscoveryEnabled: setting === 'lanDiscoveryEnabled' ? value : this.lanDiscoveryEnabled(),
      internetP2pEnabled: setting === 'internetP2pEnabled' ? value : this.internetP2pEnabled(),
      relayAllowed: setting === 'relayAllowed' ? value : this.relayAllowed(),
    };
    const p2pEnabled = next.lanDiscoveryEnabled || next.internetP2pEnabled;
    this.meshBusy.set(true);
    this.error.set(null);
    try {
      await this.invoke<void>('stop_lan_mesh');
      await firstValueFrom(this.http.patch<ApiResponse<RegisteredDevice>>(
        `${this.apiUrl}/devices/${deviceId}/settings`,
        { p2pEnabled, ...next },
      ));
      await this.loadMeshConfiguration(false);
      if (p2pEnabled) {
        await this.configureMeshApi();
        await this.invoke<void>('start_lan_mesh', next);
        this.meshStatus.set('Buscando dispositivos autorizados con las opciones seleccionadas…');
      } else {
        this.meshStatus.set('Desactivada');
        this.meshPeerStatuses.set({});
      }
    } catch {
      this.meshEnabled.set(false);
      this.error.set('No se pudo actualizar la conexión entre dispositivos. Comprueba tu conexión con CloudFusion y vuelve a intentar.');
    } finally {
      this.meshBusy.set(false);
    }
  }

  private async loadMeshConfiguration(startIfEnabled = true): Promise<void> {
    const deviceId = this.authService.deviceId;
    if (!deviceId) return;
    const [devices, peers, privacy] = await Promise.all([
      firstValueFrom(this.http.get<ApiResponse<RegisteredDevice[]>>(`${this.apiUrl}/devices`)),
      firstValueFrom(this.http.get<ApiResponse<MeshPeer[]>>(`${this.apiUrl}/devices/mesh-peers`)),
      firstValueFrom(this.http.get<ApiResponse<{ enabled: boolean }>>(`${this.apiUrl}/p2p/privacy`)),
    ]);
    this.globalP2pEnabled.set(privacy.data.enabled);
    const current = devices.data.find((item) => item.id === deviceId);
    const lan = !!current?.lanDiscoveryEnabled;
    const internet = !!current?.internetP2pEnabled;
    const relay = current?.relayAllowed ?? true;
    const enabled = privacy.data.enabled && !!current?.p2pEnabled && (lan || internet);
    this.meshEnabled.set(enabled);
    this.lanDiscoveryEnabled.set(lan);
    this.internetP2pEnabled.set(internet);
    this.relayAllowed.set(relay);
    this.serveLocalFiles.set(!!current?.serveLocalFiles);
    this.syncCoordinator.setPeerSharing(enabled, !!current?.serveLocalFiles);
    const availablePeers = privacy.data.enabled ? peers.data : [];
    this.meshPeers.set(availablePeers);
    await this.invoke<void>('set_trusted_mesh_peers', { peerIds: availablePeers.map((peer) => peer.peerId) });
    if (enabled && startIfEnabled) {
      await this.configureMeshApi();
      await this.invoke<void>('start_lan_mesh', {
        lanDiscoveryEnabled: lan,
        internetP2pEnabled: internet,
        relayAllowed: relay,
      });
    }
  }

  private async configureMeshApi(): Promise<void> {
    const accessToken = this.authService.accessToken;
    if (!accessToken) throw new Error('No active CloudFusion session');
    await this.invoke<void>('configure_mesh_api', { apiUrl: this.apiUrl, accessToken });
  }

  private async loadRemoteFolders(): Promise<void> {
    this.destinationsBusy.set(true);
    try {
      const rootResponse = await firstValueFrom(this.http.get<ApiResponse<RemoteFolder>>(`${this.apiUrl}/virtual-drive/root`));
      const root = rootResponse.data;
      const folders: Array<{ id: string; label: string }> = [{ id: root.id, label: 'Mi Drive' }];
      const pending: Array<{ node: RemoteFolder; path: string }> = [{ node: root, path: 'Mi Drive' }];
      let visited = 0;
      while (pending.length && visited < 500) {
        const batch = pending.splice(0, 8);
        const responses = await Promise.all(batch.map(({ node }) => firstValueFrom(this.http.get<ApiResponse<RemoteFolder[]>>(
          `${this.apiUrl}/virtual-drive/nodes/${node.id}/children`,
        ))));
        for (let index = 0; index < batch.length; index += 1) {
          for (const child of responses[index].data) {
            if (child.type !== 'FOLDER') continue;
            const label = `${batch[index].path} / ${child.name}`;
            folders.push({ id: child.id, label });
            pending.push({ node: child, path: label });
            visited += 1;
            if (visited >= 500) break;
          }
        }
      }
      this.remoteFolders.set(folders);
    } finally {
      this.destinationsBusy.set(false);
    }
  }

  syncStatus(rootId: string, relativePath: string): string | null {
    return this.syncCoordinator.syncStatus(rootId, relativePath);
  }

  async updateLocalFileServing(event: Event): Promise<void> {
    const enabled = (event.target as HTMLInputElement).checked;
    const deviceId = this.authService.deviceId;
    if (!deviceId) return;
    try {
      await firstValueFrom(this.http.patch<ApiResponse<RegisteredDevice>>(
        `${this.apiUrl}/devices/${deviceId}/settings`,
        { serveLocalFiles: enabled },
      ));
      this.serveLocalFiles.set(enabled);
      this.syncCoordinator.setPeerSharing(this.meshEnabled(), enabled);
      this.meshStatus.set(enabled
        ? 'Este dispositivo puede ofrecer copias verificadas a tus otros equipos.'
        : 'Este dispositivo ya no ofrece archivos a otros equipos.');
    } catch {
      this.error.set('No se pudo actualizar el permiso de compartir archivos locales.');
    }
  }

  private bridgeAvailable(): boolean {
    return typeof window !== 'undefined' && !!(window as DesktopBridge).__TAURI__?.core?.invoke;
  }

  private nativeError(error: unknown, fallback: string): string {
    if (typeof error === 'string' && error.trim()) return error;
    if (error instanceof Error && error.message) return error.message;
    return fallback;
  }

  private invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const invoke = (window as DesktopBridge).__TAURI__?.core?.invoke;
    if (!invoke) return Promise.reject(new Error('CloudFusion Desktop is not available'));
    return invoke<T>(command, args);
  }
}
