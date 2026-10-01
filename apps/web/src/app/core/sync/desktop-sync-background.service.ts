import { HttpClient, HttpParams } from '@angular/common/http';
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
  rootId: string;
  relativePath: string;
  remotePath: string;
  nodeId: string;
  versionId: string;
  contentHash: string;
  sizeBytes: string;
  conflict: boolean;
  warning?: string | null;
}

interface AvailabilityLease {
  expiresAt: string;
}

interface DeviceStorageConfiguration {
  enabled: boolean;
  maxBytes: string | null;
}

interface DeviceStorageReplicaAssignment {
  assignmentId: string;
  nodeId: string;
  versionId: string;
  contentHash: string;
  sizeBytes: string;
  attempts: number;
}

interface DeviceStorageReplicaReceipt {
  assignmentId: string;
  nodeId: string;
  versionId: string;
  contentHash: string;
  sizeBytes: string;
}

interface SyncedNodeStatus {
  status: string;
  currentVersionId: string | null;
}

interface SyncManifestEntry {
  relativePath: string;
  remotePath: string;
  versionId: string;
  checksum: string | null;
  sizeBytes: number | null;
  versionNumber: number;
}

interface RemoteVirtualNode {
  id: string;
  name: string;
  type: 'FILE' | 'FOLDER';
  currentVersionId: string | null;
  status: string;
}

interface RemoteFileVersion {
  id: string;
  versionNumber: number;
  size: number;
  checksum: string;
}

interface P2pAvailability {
  deviceId: string;
  peerId: string;
}

interface P2pTransferSession {
  id: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  nodeId: string;
  versionId: string;
  contentHash: string;
  totalBytes: string;
}

interface RemoteSyncReceipt {
  status: 'installed' | 'conflict' | 'unchanged' | 'deferred';
  relativePath: string;
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
  private remotePollTimer?: ReturnType<typeof setInterval>;
  private storageHeartbeatTimer?: ReturnType<typeof setInterval>;
  private deviceReplicaTimer?: ReturnType<typeof setInterval>;
  private deviceReplicaInFlight = false;
  private deviceReplicaRetryAt = 0;
  private remotePollInFlight = false;
  private meshEnabled = false;
  private serveLocalFiles = false;
  private uploadQueue: Promise<void> = Promise.resolve();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly advertisedCopies = new Map<string, SyncUploadReceipt>();
  private readonly availabilityTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
        if (this.remotePollTimer) clearInterval(this.remotePollTimer);
        if (this.storageHeartbeatTimer) clearInterval(this.storageHeartbeatTimer);
        if (this.deviceReplicaTimer) clearInterval(this.deviceReplicaTimer);
        this.remotePollTimer = undefined;
        this.storageHeartbeatTimer = undefined;
        this.deviceReplicaTimer = undefined;
        this.deviceReplicaRetryAt = 0;
        this.withdrawAllCopies(true);
        this.rootsState.set([]);
        this.lastUserId = null;
        void this.invoke<void>('stop_lan_mesh').catch(() => undefined);
        return;
      }
      if (user.id === this.lastUserId) return;
      if (this.lastUserId && this.lastUserId !== user.id) this.withdrawAllCopies(true);
      if (this.remotePollTimer) clearInterval(this.remotePollTimer);
      if (this.storageHeartbeatTimer) clearInterval(this.storageHeartbeatTimer);
      if (this.deviceReplicaTimer) clearInterval(this.deviceReplicaTimer);
      this.lastUserId = user.id;
      void this.refresh().then(() => {
        this.pollRemoteRoots();
        void this.reportDeviceStorageHeartbeat();
        void this.processDeviceStorageReplica();
      });
      this.remotePollTimer = setInterval(() => void this.pollRemoteRoots(), 20_000);
      this.storageHeartbeatTimer = setInterval(() => void this.reportDeviceStorageHeartbeat(), 60_000);
      this.deviceReplicaTimer = setInterval(() => void this.processDeviceStorageReplica(), 15_000);
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
    const previousRoots = this.rootsState();
    this.rootsState.set(roots);
    const configuredIds = new Set(roots.filter((root) => root.remoteNodeId).map((root) => root.id));
    for (const [key, timer] of this.debounceTimers) {
      const rootId = key.split('\u0000', 1)[0];
      if (!configuredIds.has(rootId)) {
        clearTimeout(timer);
        this.debounceTimers.delete(key);
      }
    }
    for (const [key, receipt] of this.advertisedCopies) {
      const oldRoot = previousRoots.find((root) => root.id === receipt.rootId);
      const newRoot = roots.find((root) => root.id === receipt.rootId);
      if (!configuredIds.has(receipt.rootId) || oldRoot?.remoteNodeId !== newRoot?.remoteNodeId) {
        this.withdrawCopy(key, receipt, true);
      }
    }
    if (this.lastUserId) void this.processPendingChanges();
    if (this.lastUserId) void this.pollRemoteRoots();
  }

  setPeerSharing(meshEnabled: boolean, serveLocalFiles: boolean): void {
    const wasServing = this.meshEnabled && this.serveLocalFiles;
    this.meshEnabled = meshEnabled;
    this.serveLocalFiles = serveLocalFiles;
    const isServing = meshEnabled && serveLocalFiles;
    if (wasServing && !isServing) {
      for (const [key, receipt] of this.advertisedCopies) this.withdrawCopy(key, receipt, false);
    } else if (!wasServing && isServing) {
      for (const [key, receipt] of this.advertisedCopies) void this.publishAvailability(key, receipt, false);
    }
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
      await this.invoke<number>('index_device_storage_files').catch(() => 0);
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
        lanDiscoveryEnabled: boolean;
        internetP2pEnabled: boolean;
        relayAllowed: boolean;
        serveLocalFiles: boolean;
      }>>>(`${this.apiUrl}/devices`));
      const current = response.data.find((device) => device.id === deviceId);
      const enabled = !!current?.p2pEnabled && (!!current.lanDiscoveryEnabled || !!current.internetP2pEnabled);
      this.setPeerSharing(enabled, enabled && !!current?.serveLocalFiles);
      if (!enabled) return;
      const accessToken = this.auth.accessToken;
      if (!accessToken) return;
      const peers = await firstValueFrom(this.http.get<ApiResponse<Array<{ peerId: string }>>>(`${this.apiUrl}/devices/mesh-peers`));
      await this.invoke<void>('configure_mesh_api', { apiUrl: this.apiUrl, accessToken });
      await this.invoke<void>('set_trusted_mesh_peers', { peerIds: peers.data.map((peer) => peer.peerId) });
      await this.invoke<void>('start_lan_mesh', {
        lanDiscoveryEnabled: !!current?.lanDiscoveryEnabled,
        internetP2pEnabled: !!current?.internetP2pEnabled,
        relayAllowed: current?.relayAllowed ?? true,
      });
    } catch {
      this.setPeerSharing(false, false);
      await this.invoke<void>('stop_lan_mesh').catch(() => undefined);
    }
  }

  private async reportDeviceStorageHeartbeat(): Promise<void> {
    const deviceId = this.auth.deviceId;
    if (!this.isDesktop() || !deviceId || !this.lastUserId) return;
    try {
      const configuration = await firstValueFrom(this.http.get<ApiResponse<DeviceStorageConfiguration>>(
        `${this.apiUrl}/devices/${deviceId}/storage`,
      ));
      if (!configuration.data.enabled || !configuration.data.maxBytes) return;
      const usedBytes = await this.invoke<string>('get_device_storage_usage');
      if (BigInt(usedBytes) > BigInt(configuration.data.maxBytes)) return;
      await firstValueFrom(this.http.post<ApiResponse<DeviceStorageConfiguration>>(
        `${this.apiUrl}/devices/${deviceId}/storage/heartbeat`,
        { usedBytes },
      ));
    } catch {
      // A missed heartbeat expires naturally; file sync and P2P continue independently.
    }
  }

  private async processDeviceStorageReplica(): Promise<void> {
    const deviceId = this.auth.deviceId;
    if (!this.isDesktop() || !deviceId || !this.lastUserId || this.deviceReplicaInFlight || Date.now() < this.deviceReplicaRetryAt) return;
    this.deviceReplicaInFlight = true;
    try {
      await firstValueFrom(this.auth.ensureSession());
      const accessToken = this.auth.accessToken;
      if (!accessToken) return;
      const [configuration, storageRoot] = await Promise.all([
        firstValueFrom(this.http.get<ApiResponse<DeviceStorageConfiguration>>(`${this.apiUrl}/devices/${deviceId}/storage`)),
        this.invoke<{ path: string } | null>('get_device_storage_root'),
      ]);
      if (!configuration.data.enabled || !configuration.data.maxBytes || !storageRoot) return;
      const response = await firstValueFrom(this.http.post<ApiResponse<{ assignment: DeviceStorageReplicaAssignment | null }>>(
        `${this.apiUrl}/p2p/storage/replicas/next`,
        {},
      ));
      const assignment = response.data.assignment;
      if (!assignment) return;
      const receipt = await this.invoke<DeviceStorageReplicaReceipt>('store_device_replica', {
        apiUrl: this.apiUrl,
        accessToken,
        maxBytes: configuration.data.maxBytes,
        assignment,
      });
      await firstValueFrom(this.http.post<ApiResponse<{ status: string }>>(
        `${this.apiUrl}/p2p/storage/replicas/${assignment.assignmentId}/complete`,
        { contentHash: receipt.contentHash, sizeBytes: receipt.sizeBytes },
      ));
      await this.reportDeviceStorageHeartbeat();
      this.deviceReplicaRetryAt = 0;
      this.syncNotice.set('Réplica del dispositivo guardada y verificada. La copia cloud durable se mantiene intacta.');
    } catch {
      this.deviceReplicaRetryAt = Date.now() + 60_000;
    } finally {
      this.deviceReplicaInFlight = false;
    }
  }

  private handleLocalChange(change: DesktopSyncChange, debounce = true): void {
    this.changes.update((items) => [change, ...items.filter((item) => item.id !== change.id)].slice(0, 500));
    const root = this.rootsState().find((item) => item.id === change.rootId);
    if (!root?.remoteNodeId) return;
    const key = this.statusKey(change.rootId, change.relativePath);
    if (change.operation === 'deleted') {
      this.withdrawCopiesForPath(change.rootId, change.relativePath);
      this.syncStates.update((states) => ({ ...states, [key]: 'Eliminación detectada; la copia de Mi Drive se conserva por seguridad.' }));
      return;
    }
    if (!['created', 'modified', 'changed'].includes(change.operation)) return;
    this.withdrawCopiesForPath(change.rootId, change.relativePath);
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

  private async pollRemoteRoots(): Promise<void> {
    if (this.remotePollInFlight || !this.lastUserId || !this.isDesktop()) return;
    this.remotePollInFlight = true;
    try {
      const session = await firstValueFrom(this.auth.ensureSession());
      const accessToken = this.auth.accessToken;
      if (!session || !accessToken) return;
      if (this.meshEnabled) {
        await this.invoke<void>('configure_mesh_api', { apiUrl: this.apiUrl, accessToken }).catch(() => undefined);
      }
      const pending = await this.invoke<DesktopSyncChange[]>('get_pending_sync_changes', { limit: 500 });
      for (const root of this.rootsState()) {
        if (!root.remoteNodeId) continue;
        try {
          await this.pollRemoteRoot(root, pending, accessToken);
        } catch {
          // Retry this root on the next background interval without interrupting other roots.
        }
      }
    } catch {
      // Background polling is best-effort; a later interval retries when the API is available.
    } finally {
      this.remotePollInFlight = false;
    }
  }

  private async pollRemoteRoot(
    root: DesktopSyncRoot,
    pending: DesktopSyncChange[],
    accessToken: string,
  ): Promise<void> {
    const [manifest, files] = await Promise.all([
      this.invoke<SyncManifestEntry[]>('get_sync_manifest', { rootId: root.id }),
      this.listRemoteFiles(root.remoteNodeId!),
    ]);
    const entriesByRemotePath = new Map<string, SyncManifestEntry[]>();
    for (const entry of manifest) {
      const entries = entriesByRemotePath.get(entry.remotePath) ?? [];
      entries.push(entry);
      entriesByRemotePath.set(entry.remotePath, entries);
    }
    for (const { node, relativePath } of files) {
      try {
        if (!node.currentVersionId || ['UPLOADING', 'UNAVAILABLE', 'ERROR', 'DELETING'].includes(node.status)) continue;
        const related = entriesByRemotePath.get(relativePath) ?? [];
        if (related.some((entry) => entry.versionId === node.currentVersionId)) continue;
        const protectedPaths = related.length ? related.map((entry) => entry.relativePath) : [relativePath];
        if (pending.some((change) => change.rootId === root.id && protectedPaths.includes(change.relativePath))) continue;

        const versions = await firstValueFrom(this.http.get<ApiResponse<RemoteFileVersion[]>>(
          `${this.apiUrl}/virtual-drive/nodes/${node.id}/versions`,
        ));
        const version = versions.data.find((item) => item.id === node.currentVersionId);
        if (!version || !Number.isSafeInteger(version.size) || version.size < 0 || !/^[a-f\d]{64}$/i.test(version.checksum)) continue;

        const received = await this.receiveRemoteVersion(root, relativePath, node, version, accessToken);
        if (received.receipt.status === 'deferred' || received.receipt.status === 'unchanged') continue;
        const key = this.statusKey(root.id, received.receipt.relativePath);
        const conflict = received.receipt.status === 'conflict';
        const transport = received.transport === 'peer' ? 'desde otro dispositivo' : 'desde CloudFusion';
        const notice = conflict
          ? `KEEP_BOTH: se conservó el archivo local y la versión remota quedó en ${received.receipt.relativePath}.`
          : `Versión remota recibida ${transport}: ${received.receipt.relativePath}.`;
        this.syncStates.update((states) => ({ ...states, [key]: notice }));
        this.syncNotice.set(notice);

        if (this.meshEnabled && this.serveLocalFiles) {
          void this.advertiseSyncedCopy({
            rootId: root.id,
            relativePath: received.receipt.relativePath,
            remotePath: relativePath,
            nodeId: node.id,
            versionId: node.currentVersionId,
            contentHash: version.checksum,
            sizeBytes: String(version.size),
            conflict,
          }, key);
        }
      } catch (error) {
        const key = this.statusKey(root.id, relativePath);
        this.syncStates.update((states) => ({
          ...states,
          [key]: this.nativeError(error, 'No se pudo recibir la versión remota.'),
        }));
      }
    }
  }

  private async listRemoteFiles(remoteRootId: string): Promise<Array<{ node: RemoteVirtualNode; relativePath: string }>> {
    const pendingFolders = [{ id: remoteRootId, path: '', depth: 0 }];
    const visited = new Set<string>([remoteRootId]);
    const files: Array<{ node: RemoteVirtualNode; relativePath: string }> = [];
    let nextFolder = 0;
    while (nextFolder < pendingFolders.length) {
      const folder = pendingFolders[nextFolder++];
      if (folder.depth >= 64) continue;
      const response = await firstValueFrom(this.http.get<ApiResponse<RemoteVirtualNode[]>>(
        `${this.apiUrl}/virtual-drive/nodes/${folder.id}/children`,
      ));
      for (const node of response.data) {
        const relativePath = folder.path ? `${folder.path}/${node.name}` : node.name;
        if (node.type === 'FOLDER') {
          if (!visited.has(node.id) && visited.size < 50_000) {
            visited.add(node.id);
            pendingFolders.push({ id: node.id, path: relativePath, depth: folder.depth + 1 });
          }
        } else if (node.type === 'FILE') {
          files.push({ node, relativePath });
          if (files.length >= 50_000) return files;
        }
      }
    }
    return files;
  }

  private async receiveRemoteVersion(
    root: DesktopSyncRoot,
    remotePath: string,
    node: RemoteVirtualNode,
    version: RemoteFileVersion,
    accessToken: string,
  ): Promise<{ receipt: RemoteSyncReceipt; transport: 'peer' | 'cloud' }> {
    const stagingPath = await this.invoke<string>('get_sync_download_staging_path', {
      rootId: root.id,
      remotePath,
      versionId: version.id,
    });
    const destinationDeviceId = this.auth.deviceId;
    if (this.meshEnabled && destinationDeviceId) {
      try {
        const params = new HttpParams().set('nodeId', node.id).set('versionId', version.id);
        const sources = await firstValueFrom(this.http.get<ApiResponse<P2pAvailability[]>>(
          `${this.apiUrl}/p2p/availability`, { params },
        ));
        for (const source of sources.data.filter((item) => item.deviceId !== destinationDeviceId)) {
          try {
            const authorization = await firstValueFrom(this.http.post<ApiResponse<{
              transfer: P2pTransferSession;
              ticket: string;
            }>>(`${this.apiUrl}/p2p/transfers/authorize`, {
              sourceDeviceId: source.deviceId,
              nodeId: node.id,
              versionId: version.id,
            }));
            const { transfer, ticket } = authorization.data;
            await this.invoke<string>('download_p2p_file', {
              apiUrl: this.apiUrl,
              accessToken,
              transferId: transfer.id,
              ticket,
              sourcePeerId: source.peerId,
              destinationDeviceId,
              sourceDeviceId: transfer.sourceDeviceId,
              nodeId: transfer.nodeId,
              versionId: transfer.versionId,
              contentHash: transfer.contentHash,
              totalBytes: transfer.totalBytes,
              destinationPath: stagingPath,
            });
            const receipt = await this.invoke<RemoteSyncReceipt>('install_sync_download', {
              rootId: root.id,
              remotePath,
              nodeId: node.id,
              versionId: version.id,
              checksum: version.checksum,
              sizeBytes: String(version.size),
              versionNumber: version.versionNumber,
              stagingPath,
            });
            return { receipt, transport: 'peer' };
          } catch {
            // Try another currently advertised peer, then use the verified cloud stream.
          }
        }
      } catch {
        // P2P discovery can be unavailable while the normal CloudFusion download still works.
      }
    }
    const receipt = await this.invoke<RemoteSyncReceipt>('download_sync_version_from_cloud', {
      rootId: root.id,
      remotePath,
      nodeId: node.id,
      versionId: version.id,
      checksum: version.checksum,
      sizeBytes: String(version.size),
      versionNumber: version.versionNumber,
      apiUrl: this.apiUrl,
      accessToken,
    });
    return { receipt, transport: 'cloud' };
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
        this.advertisedCopies.set(this.availabilityKey(receipt), receipt);
        await this.publishAvailability(this.availabilityKey(receipt), receipt, true);
        return;
      } catch {
        // Retry brief API/provider replication delays without failing the saved cloud copy.
      }
    }
    this.setPeerNotice(key, 'La copia cloud quedó guardada, pero todavía no se pudo anunciar como fuente P2P.');
  }

  private async publishAvailability(key: string, receipt: SyncUploadReceipt, announce: boolean): Promise<void> {
    if (!this.meshEnabled || !this.serveLocalFiles) return;
    this.advertisedCopies.set(key, receipt);
    try {
      const hasLocalCopy = await this.invoke<boolean>('verify_sync_file_copy', {
        rootId: receipt.rootId,
        relativePath: receipt.relativePath,
        contentHash: receipt.contentHash,
        sizeBytes: receipt.sizeBytes,
      });
      if (!hasLocalCopy) {
        this.withdrawCopy(key, receipt, true);
        if (announce) this.setPeerNotice(this.statusKey(receipt.rootId, receipt.relativePath), 'La copia local ya no coincide con la versión anunciada; no se compartirá por P2P.');
        return;
      }
      if (this.advertisedCopies.get(key) !== receipt || !this.meshEnabled || !this.serveLocalFiles) return;
      const response = await firstValueFrom(this.http.post<ApiResponse<AvailabilityLease>>(
        `${this.apiUrl}/p2p/availability`,
        {
          nodeId: receipt.nodeId,
          versionId: receipt.versionId,
          contentHash: receipt.contentHash,
          sizeBytes: receipt.sizeBytes,
        },
      ));
      this.scheduleAvailabilityRenewal(key, receipt, response.data.expiresAt);
      if (announce) this.setPeerNotice(this.statusKey(receipt.rootId, receipt.relativePath), 'La copia local verificada está disponible para tus otros dispositivos.');
    } catch {
      this.scheduleAvailabilityRenewal(key, receipt, undefined, 30_000);
      if (announce) this.setPeerNotice(this.statusKey(receipt.rootId, receipt.relativePath), 'La copia cloud quedó guardada; se reintentará anunciar la fuente P2P.');
    }
  }

  private scheduleAvailabilityRenewal(
    key: string,
    receipt: SyncUploadReceipt,
    expiresAt?: string,
    retryDelay?: number,
  ): void {
    const existing = this.availabilityTimers.get(key);
    if (existing) clearTimeout(existing);
    const remaining = expiresAt ? Date.parse(expiresAt) - Date.now() : Number.NaN;
    const delay = retryDelay ?? (Number.isFinite(remaining) ? Math.max(15_000, Math.floor(remaining / 2)) : 7 * 60_000);
    const timer = setTimeout(() => {
      this.availabilityTimers.delete(key);
      void this.renewAvailability(key, receipt);
    }, delay);
    this.availabilityTimers.set(key, timer);
  }

  private async renewAvailability(key: string, receipt: SyncUploadReceipt): Promise<void> {
    if (this.advertisedCopies.get(key) !== receipt || !this.meshEnabled || !this.serveLocalFiles) return;
    try {
      const hasLocalCopy = await this.invoke<boolean>('verify_sync_file_copy', {
        rootId: receipt.rootId,
        relativePath: receipt.relativePath,
        contentHash: receipt.contentHash,
        sizeBytes: receipt.sizeBytes,
      });
      if (!hasLocalCopy) {
        this.withdrawCopy(key, receipt, true);
        return;
      }
      const response = await firstValueFrom(this.http.get<ApiResponse<SyncedNodeStatus>>(
        `${this.apiUrl}/virtual-drive/nodes/${receipt.nodeId}`,
      ));
      if (this.advertisedCopies.get(key) !== receipt || !this.meshEnabled || !this.serveLocalFiles) return;
      if (response.data.currentVersionId !== receipt.versionId) {
        this.withdrawCopy(key, receipt, true);
        this.syncStates.update((states) => ({
          ...states,
          [this.statusKey(receipt.rootId, receipt.relativePath)]: 'La versión remota cambió; se retiró la fuente P2P anterior.',
        }));
        return;
      }
      const lease = await firstValueFrom(this.http.post<ApiResponse<AvailabilityLease>>(
        `${this.apiUrl}/p2p/availability`,
        {
          nodeId: receipt.nodeId,
          versionId: receipt.versionId,
          contentHash: receipt.contentHash,
          sizeBytes: receipt.sizeBytes,
        },
      ));
      this.scheduleAvailabilityRenewal(key, receipt, lease.data.expiresAt);
    } catch {
      this.scheduleAvailabilityRenewal(key, receipt, undefined, 30_000);
    }
  }

  private withdrawCopiesForPath(rootId: string, relativePath: string): void {
    for (const [key, receipt] of this.advertisedCopies) {
      if (receipt.rootId === rootId && receipt.relativePath === relativePath) this.withdrawCopy(key, receipt, true);
    }
  }

  private withdrawAllCopies(forget: boolean): void {
    for (const [key, receipt] of this.advertisedCopies) this.withdrawCopy(key, receipt, forget);
  }

  private withdrawCopy(key: string, receipt: SyncUploadReceipt, forget: boolean): void {
    const timer = this.availabilityTimers.get(key);
    if (timer) clearTimeout(timer);
    this.availabilityTimers.delete(key);
    if (forget) this.advertisedCopies.delete(key);
    void firstValueFrom(this.http.delete<ApiResponse<{ withdrawn: boolean }>>(
      `${this.apiUrl}/p2p/availability/${receipt.nodeId}/${receipt.versionId}`,
    )).catch(() => undefined);
  }

  private availabilityKey(receipt: SyncUploadReceipt): string {
    return `${receipt.nodeId}\u0000${receipt.versionId}`;
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
