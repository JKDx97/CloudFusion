import { HttpClient } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api-response.model';

export interface DesktopSyncRoot {
  id: string;
  path: string;
  remoteNodeId?: string | null;
}

export interface DesktopSyncChange {
  id: string;
  rootId: string;
  relativePath: string;
  operation: string;
  detectedAtMs: number;
}

interface SyncUploadReceipt {
  relativePath: string;
  nodeId: string;
  versionId: string;
  contentHash: string;
  sizeBytes: string;
  conflict: boolean;
  warning?: string | null;
}

interface SyncedNodeStatus {
  status: string;
  currentVersionId: string | null;
}

interface DesktopBridge extends Window {
  __TAURI__?: {
    core?: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
    event?: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
  };
}

@Injectable({ providedIn: 'root' })
export class DesktopSyncBackgroundService {
  private readonly apiUrl = environment.apiUrl;
  private readonly rootsState = signal<DesktopSyncRoot[]>([]);
  readonly roots = this.rootsState.asReadonly();
  readonly changes = signal<DesktopSyncChange[]>([]);
  readonly syncStates = signal<Record<string, string>>({});
  readonly syncNotice = signal<string | null>(null);

  private started = false;
  private lastUserId: string | null = null;
  private refreshInFlight?: Promise<void>;
  private meshEnabled = false;
  private serveLocalFiles = false;
  private uploadQueue: Promise<void> = Promise.resolve();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly http: HttpClient,
    private readonly auth: AuthService,
  ) {}

  start(): void {
    if (this.started || !this.isDesktop()) return;
    this.started = true;
    const events = (window as DesktopBridge).__TAURI__?.event;
    void events?.listen<DesktopSyncChange>('sync-change', ({ payload }) => this.handleLocalChange(payload))
      .catch(() => undefined);

    this.auth.currentUser$.subscribe((user) => {
      if (!user) {
        this.lastUserId = null;
        return;
      }
      if (user.id === this.lastUserId) return;
      this.lastUserId = user.id;
      void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    if (!this.isDesktop()) return;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.loadLocalState();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  setRoots(roots: DesktopSyncRoot[]): void {
    this.rootsState.set(roots);
    const configuredIds = new Set(roots.filter((root) => root.remoteNodeId).map((root) => root.id));
    for (const [key, timer] of this.debounceTimers) {
      const rootId = key.split('\u0000', 1)[0];
      if (!configuredIds.has(rootId)) {
        clearTimeout(timer);
        this.debounceTimers.delete(key);
      }
    }
    if (this.lastUserId) void this.processPendingChanges();
  }

  setPeerSharing(meshEnabled: boolean, serveLocalFiles: boolean): void {
    this.meshEnabled = meshEnabled;
    this.serveLocalFiles = serveLocalFiles;
  }

  syncFile(rootId: string, relativePath: string): Promise<boolean> {
    return this.queueUpload({
      id: '', rootId, relativePath, operation: 'modified', detectedAtMs: Date.now(),
    });
  }

  retryChange(change: DesktopSyncChange): Promise<boolean> {
    return this.queueUpload(change);
  }

  syncStatus(rootId: string, relativePath: string): string | null {
    return this.syncStates()[this.statusKey(rootId, relativePath)] ?? null;
  }

  canRetry(change: DesktopSyncChange): boolean {
    const status = this.syncStatus(change.rootId, change.relativePath);
    return !!status && !/^(Esperando|En cola|Subiendo|Sincronizado|Eliminación)/.test(status);
  }

  private async loadLocalState(): Promise<void> {
    try {
      const session = await firstValueFrom(this.auth.ensureSession());
      if (!session) return;
      const [roots, pending] = await Promise.all([
        this.invoke<DesktopSyncRoot[]>('get_sync_roots'),
        this.invoke<DesktopSyncChange[]>('get_pending_sync_changes', { limit: 500 }),
      ]);
      this.rootsState.set(roots);
      await this.loadPeerSharingSettings();
      this.changes.set(pending.reverse());
      const latest = new Map<string, DesktopSyncChange>();
      for (const change of this.changes()) latest.set(this.statusKey(change.rootId, change.relativePath), change);
      for (const change of latest.values()) this.handleLocalChange(change, false);
    } catch {
      // Keep the local journal intact; a later login or app start retries it.
    }
  }

  private async loadPeerSharingSettings(): Promise<void> {
    const deviceId = this.auth.deviceId;
    if (!deviceId) return;
    try {
      const response = await firstValueFrom(this.http.get<ApiResponse<Array<{
        id: string;
        p2pEnabled: boolean;
        serveLocalFiles: boolean;
      }>>>(`${this.apiUrl}/devices`));
      const current = response.data.find((device) => device.id === deviceId);
      this.setPeerSharing(!!current?.p2pEnabled, !!current?.serveLocalFiles);
    } catch {
      this.setPeerSharing(false, false);
    }
  }

  private handleLocalChange(change: DesktopSyncChange, debounce = true): void {
    this.changes.update((items) => [change, ...items.filter((item) => item.id !== change.id)].slice(0, 500));
    const root = this.rootsState().find((item) => item.id === change.rootId);
    if (!root?.remoteNodeId) return;
    const key = this.statusKey(change.rootId, change.relativePath);
    if (change.operation === 'deleted') {
      this.syncStates.update((states) => ({ ...states, [key]: 'Eliminación detectada; la copia de Mi Drive se conserva por seguridad.' }));
      return;
    }
    if (!['created', 'modified', 'changed'].includes(change.operation)) return;
    const oldTimer = this.debounceTimers.get(key);
    if (oldTimer) clearTimeout(oldTimer);
    this.syncStates.update((states) => ({ ...states, [key]: 'Esperando que termine el cambio…' }));
    if (!debounce) {
      void this.queueUpload(change);
      return;
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      void this.queueUpload(change);
    }, 1200);
    this.debounceTimers.set(key, timer);
  }

  private async processPendingChanges(): Promise<void> {
    const latest = new Map<string, DesktopSyncChange>();
    for (const change of this.changes()) latest.set(this.statusKey(change.rootId, change.relativePath), change);
    for (const change of latest.values()) this.handleLocalChange(change, false);
  }

  private queueUpload(change: DesktopSyncChange): Promise<boolean> {
    const key = this.statusKey(change.rootId, change.relativePath);
    this.syncStates.update((states) => ({ ...states, [key]: 'En cola…' }));
    const next = this.uploadQueue.then(() => this.uploadChange(change));
    this.uploadQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async uploadChange(change: DesktopSyncChange): Promise<boolean> {
    const key = this.statusKey(change.rootId, change.relativePath);
    const root = this.rootsState().find((item) => item.id === change.rootId);
    if (!root?.remoteNodeId) {
      this.syncStates.update((states) => ({ ...states, [key]: 'Elige una carpeta de destino para activar la sincronización.' }));
      return false;
    }
    if (change.operation === 'deleted') {
      this.syncStates.update((states) => ({ ...states, [key]: 'Eliminación detectada; no se borra la copia de Mi Drive automáticamente.' }));
      return false;
    }
    try {
      const session = await firstValueFrom(this.auth.ensureSession());
      const accessToken = this.auth.accessToken;
      if (!session || !accessToken) throw new Error('La sesión venció. Inicia sesión otra vez para continuar.');
      const acknowledgedChanges = this.changes().filter((item) =>
        item.rootId === change.rootId && item.relativePath === change.relativePath && item.operation !== 'deleted',
      );
      this.syncStates.update((states) => ({ ...states, [key]: 'Subiendo a Mi Drive…' }));
      const receipt = await this.invoke<SyncUploadReceipt>('upload_sync_change', {
        rootId: change.rootId,
        relativePath: change.relativePath,
        apiUrl: this.apiUrl,
        accessToken,
      });
      let peerNotice = '';
      if (this.meshEnabled && this.serveLocalFiles) {
        peerNotice = ' Comprobando cuándo termina el guardado cloud para anunciar la copia P2P…';
        void this.advertiseSyncedCopy(receipt, key);
      }
      for (const item of acknowledgedChanges) await this.invoke<boolean>('acknowledge_sync_change', { id: item.id });
      this.changes.update((items) => items.filter((item) => !acknowledgedChanges.some((done) => done.id === item.id)));
      const conflict = receipt.conflict ? ' (copia en conflicto conservada)' : '';
      this.syncStates.update((states) => ({ ...states, [key]: receipt.warning || `Sincronizado${conflict}.${peerNotice}` }));
      this.syncNotice.set(receipt.warning || `Archivo sincronizado: ${receipt.relativePath}${conflict}.${peerNotice}`);
      return true;
    } catch (error) {
      this.syncStates.update((states) => ({ ...states, [key]: this.nativeError(error, 'No se pudo sincronizar este archivo.') }));
      return false;
    }
  }

  private async advertiseSyncedCopy(receipt: SyncUploadReceipt, key: string): Promise<void> {
    const retryDelays = [0, 1_000, 2_000, 4_000, 8_000, 15_000];
    for (const delay of retryDelays) {
      if (!this.meshEnabled || !this.serveLocalFiles) return;
      if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      try {
        const response = await firstValueFrom(this.http.get<ApiResponse<SyncedNodeStatus>>(
          `${this.apiUrl}/virtual-drive/nodes/${receipt.nodeId}`,
        ));
        const node = response.data;
        if (node.currentVersionId !== receipt.versionId) {
          this.setPeerNotice(key, 'La versión cambió antes de anunciarse; la copia cloud sigue sincronizada.');
          return;
        }
        if (node.status === 'UNAVAILABLE' || node.status === 'ERROR') break;
        if (node.status !== 'AVAILABLE') continue;
        await firstValueFrom(this.http.post<ApiResponse<unknown>>(`${this.apiUrl}/p2p/availability`, {
          nodeId: receipt.nodeId,
          versionId: receipt.versionId,
          contentHash: receipt.contentHash,
          sizeBytes: receipt.sizeBytes,
        }));
        this.setPeerNotice(key, 'La copia local verificada está disponible para tus otros dispositivos.');
        return;
      } catch {
        // Retry brief API/provider replication delays without failing the saved cloud copy.
      }
    }
    this.setPeerNotice(key, 'La copia cloud quedó guardada, pero todavía no se pudo anunciar como fuente P2P.');
  }

  private setPeerNotice(key: string, message: string): void {
    this.syncStates.update((states) => ({ ...states, [key]: `Sincronizado. ${message}` }));
    this.syncNotice.set(message);
  }

  private statusKey(rootId: string, relativePath: string): string {
    return `${rootId}\u0000${relativePath}`;
  }

  private nativeError(error: unknown, fallback: string): string {
    if (typeof error === 'string' && error.trim()) return error;
    if (error instanceof Error && error.message) return error.message;
    return fallback;
  }

  private isDesktop(): boolean {
    return typeof window !== 'undefined' && !!(window as DesktopBridge).__TAURI__?.core?.invoke;
  }

  private invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const invoke = (window as DesktopBridge).__TAURI__?.core?.invoke;
    if (!invoke) return Promise.reject(new Error('CloudFusion Desktop is not available'));
    return invoke<T>(command, args);
  }
}
