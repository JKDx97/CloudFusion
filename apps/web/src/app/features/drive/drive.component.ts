import { CommonModule, DatePipe } from '@angular/common';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { CloudService } from '../../core/cloud/cloud.service';
import { environment } from '../../../environments/environment';
import { CreatePublicShareResult, CreateShareInvitationResult, FileVersionRecord, PublicShareExpiry, PublicSharePermission, PublicShareRecord, ResourceShareRecord, ResourceShareRole, ShareInvitationRecord, ShareUser, VirtualNode } from '../../shared/models/cloud.model';
import { ApiResponse } from '../../shared/models/api-response.model';
import { TransferPathSelector } from './transfer-path-selector';

type DriveSection = 'drive' | 'recent' | 'favorites' | 'shared' | 'trash';
interface P2pAvailability {
  deviceId: string;
  name: string;
  platform: string;
  peerId: string;
  lastVerifiedAt: string;
  expiresAt: string;
  advertisedSize: string;
}

interface P2pMeshPeerUpdate {
  peerId: string;
  status: string;
  multiaddr: string | null;
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

interface P2pTransferProgress {
  transferId: string;
  bytesTransferred: string;
  totalBytes: string;
  status: string;
  transport?: string;
}

interface RegisteredP2pDevice {
  id: string;
  p2pEnabled: boolean;
  lanDiscoveryEnabled: boolean;
  internetP2pEnabled: boolean;
  relayAllowed: boolean;
}

interface TrustedP2pPeer {
  peerId: string;
}

interface DesktopInvokeWindow extends Window {
  __TAURI__?: {
    core?: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
    event?: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
  };
}

@Component({
  standalone: true,
  imports: [CommonModule, DatePipe, RouterLink],
  selector: 'app-drive',
  templateUrl: './drive.component.html',
})
export class DriveComponent implements OnInit {
  readonly desktopSyncAvailable = typeof window !== 'undefined' && !!(window as Window & { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core?.invoke;
  private readonly cloud = inject(CloudService);
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly apiUrl = environment.apiUrl;
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly transferPathSelector = new TransferPathSelector();
  readonly nodes = signal<VirtualNode[]>([]);
  readonly breadcrumbs = signal<VirtualNode[]>([]);
  readonly root = signal<VirtualNode | null>(null);
  readonly currentParent = signal<VirtualNode | null>(null);
  readonly section = signal<DriveSection>('drive');
  readonly loading = signal(false);
  readonly notice = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly versionTarget = signal<VirtualNode | null>(null);
  readonly versions = signal<FileVersionRecord[]>([]);
  readonly versionLoading = signal(false);
  readonly versionComment = signal('');
  readonly shareRoles = signal<Record<string, ResourceShareRole>>({});
  readonly shareOwners = signal<Record<string, string>>({});
  readonly activeShareRole = signal<ResourceShareRole | null>(null);
  readonly shareTarget = signal<VirtualNode | null>(null);
  readonly shareEntries = signal<ResourceShareRecord[]>([]);
  readonly shareInvitations = signal<ShareInvitationRecord[]>([]);
  readonly shareEmail = signal('');
  readonly shareRole = signal<ResourceShareRole>('VIEWER');
  readonly shareQuery = signal('');
  readonly shareUsers = signal<ShareUser[]>([]);
  readonly shareBusy = signal(false);
  readonly shareError = signal<string | null>(null);
  readonly invitationToken = signal<string | null>(null);
  readonly invitationExpiresAt = signal<string | null>(null);
  readonly invitationAcceptToken = signal('');
  readonly invitationAcceptError = signal<string | null>(null);
  readonly invitationAcceptBusy = signal(false);
  readonly publicShares = signal<PublicShareRecord[]>([]);
  readonly publicPermission = signal<PublicSharePermission>('DOWNLOAD');
  readonly publicExpiry = signal<PublicShareExpiry>('7_DAYS');
  readonly publicPassword = signal('');
  readonly publicDownloadLimit = signal('');
  readonly publicLink = signal<CreatePublicShareResult | null>(null);
  readonly p2pSources = signal<Record<string, P2pAvailability[]>>({});
  readonly p2pLookupVersion = signal<string | null>(null);
  readonly p2pBusyVersion = signal<string | null>(null);
  readonly p2pProgress = signal<P2pTransferProgress | null>(null);
  readonly meshPeerStatuses = signal<Record<string, string>>({});
  private meshPeerListenerReady: Promise<void> | null = null;

  ngOnInit(): void {
    this.openDrive();
    this.listenForP2pProgress();
    void this.startMeshForActiveDesktopDevice();
  }

  async announceLocalVersion(version: FileVersionRecord): Promise<void> {
    const target = this.versionTarget();
    if (!target || !this.desktopSyncAvailable) return;
    try {
      const indexed = await this.invokeDesktop<boolean>('has_indexed_file_version', {
        contentHash: version.checksum,
        sizeBytes: String(version.size),
      });
      if (!indexed) {
        this.fail('No hay una copia local íntegra de esta versión. Analiza primero las carpetas en Sincronización Desktop.');
        return;
      }
      await firstValueFrom(this.http.post<ApiResponse<unknown>>(`${this.apiUrl}/p2p/availability`, {
        nodeId: target.id,
        versionId: version.id,
        contentHash: version.checksum,
        sizeBytes: String(version.size),
      }));
      this.announce(`v${version.versionNumber} está disponible para tus otros dispositivos durante un tiempo limitado.`);
    } catch {
      this.fail('No se pudo anunciar esta copia. Activa la conexión entre dispositivos y el permiso para compartir archivos en Sincronización Desktop.');
    }
  }

  async findP2pSources(version: FileVersionRecord): Promise<void> {
    const target = this.versionTarget();
    if (!target) return;
    this.p2pLookupVersion.set(version.id);
    try {
      const otherDevices = await this.fetchP2pSources(target.id, version.id);
      this.p2pSources.update((sources) => ({ ...sources, [version.id]: otherDevices }));
      if (!otherDevices.length) this.announce('Ningún otro dispositivo ofrece esta versión ahora.');
    } catch {
      this.fail('No se pudo consultar la disponibilidad P2P de esta versión.');
    } finally {
      this.p2pLookupVersion.set(null);
    }
  }

  async downloadAutomatically(version: FileVersionRecord): Promise<void> {
    const target = this.versionTarget();
    const destinationDeviceId = this.auth.deviceId;
    const accessToken = this.auth.accessToken;
    if (!target || !destinationDeviceId || !accessToken || !this.desktopSyncAvailable) {
      this.fail('Inicia sesión en CloudFusion Desktop y activa la conexión entre dispositivos para usar la descarga inteligente.');
      return;
    }
    this.p2pBusyVersion.set(version.id);
    try {
      let sources: P2pAvailability[] = [];
      try {
        sources = await this.fetchP2pSources(target.id, version.id);
      } catch {
        // A failed peer lookup still permits the existing, permission-checked cloud download.
      }
      this.p2pSources.update((current) => ({ ...current, [version.id]: sources }));

      const orderedSources = this.transferPathSelector.orderSources(sources, this.meshPeerStatuses());
      if (orderedSources.length) {
        const destinationPath = await this.invokeDesktop<string | null>('choose_p2p_destination', {
          fileName: `${target.name}.v${version.versionNumber}`,
        });
        if (!destinationPath) return;
        for (const source of orderedSources) {
          try {
            await this.tryP2pDownload(version, target.id, source, destinationPath, destinationDeviceId, accessToken);
            this.announce(`Versión verificada recibida por ${this.peerRouteLabel(source.peerId)} y guardada en ${destinationPath}.`);
            return;
          } catch {
            // Try the next authorized local copy before using the cloud replica.
          }
        }
      }

      const progressId = `cloud-${version.id}-${Date.now()}`;
      this.p2pProgress.set({
        transferId: progressId,
        bytesTransferred: '0',
        totalBytes: String(version.size),
        status: 'CLOUD_FALLBACK',
        transport: 'CLOUD_FALLBACK',
      });
      try {
        const blob = await firstValueFrom(this.cloud.downloadFileVersion(target.id, version.id));
        this.saveDownload(blob, `${target.name}.v${version.versionNumber}`);
        this.p2pProgress.update((progress) => ({
          transferId: progress?.transferId ?? progressId,
          bytesTransferred: String(version.size),
          totalBytes: String(version.size),
          status: 'CLOUD_FALLBACK_COMPLETED',
          transport: 'CLOUD_FALLBACK',
        }));
        this.announce(orderedSources.length
          ? 'Las rutas entre dispositivos no estuvieron disponibles; CloudFusion descargó la versión autorizada desde la nube.'
          : 'Ningún dispositivo anunció una copia local; CloudFusion descargó la versión autorizada desde la nube.');
      } catch {
        this.p2pProgress.update((progress) => progress ? { ...progress, status: 'CLOUD_FALLBACK_FAILED' } : null);
        this.fail('No se pudo recibir el archivo desde los dispositivos ni recuperar su réplica cloud.');
      }
    } catch {
      this.fail('No se pudo iniciar la descarga. Comprueba CloudFusion Desktop y vuelve a intentarlo.');
    } finally {
      this.p2pBusyVersion.set(null);
    }
  }

  private async fetchP2pSources(nodeId: string, versionId: string): Promise<P2pAvailability[]> {
    const params = new HttpParams().set('nodeId', nodeId).set('versionId', versionId);
    const response = await firstValueFrom(this.http.get<ApiResponse<P2pAvailability[]>>(
      `${this.apiUrl}/p2p/availability`, { params },
    ));
    return response.data.filter((source) => source.deviceId !== this.auth.deviceId);
  }

  private async tryP2pDownload(
    version: FileVersionRecord,
    nodeId: string,
    source: P2pAvailability,
    destinationPath: string,
    destinationDeviceId: string,
    accessToken: string,
  ): Promise<void> {
    const authorization = await firstValueFrom(this.http.post<ApiResponse<{
      transfer: P2pTransferSession;
      ticket: string;
    }>>(`${this.apiUrl}/p2p/transfers/authorize`, {
      sourceDeviceId: source.deviceId,
      nodeId,
      versionId: version.id,
    }));
    const { transfer, ticket } = authorization.data;
    this.p2pProgress.set({
      transferId: transfer.id,
      bytesTransferred: '0',
      totalBytes: transfer.totalBytes,
      status: 'AUTHORIZED',
    });
    await this.invokeDesktop<string>('download_p2p_file', {
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
      destinationPath,
    });
  }

  private peerRouteLabel(peerId: string): string {
    const status = this.meshPeerStatuses()[peerId] ?? '';
    if (status === 'connected:LAN_DIRECT') return 'LAN directa';
    if (status === 'connected:P2P_DIRECT') return 'P2P directa';
    if (status === 'connected:P2P_RELAY') return 'relay P2P';
    return 'la conexión P2P disponible';
  }

  openDrive(): void {
    this.section.set('drive');
    this.loading.set(true);
    this.cloud.getVirtualRoot().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (root) => {
        this.root.set(root);
        this.currentParent.set(root);
        this.breadcrumbs.set([]);
        this.loadChildren(root);
      },
      error: () => this.fail('No se pudo abrir CloudFusion Drive.'),
    });
  }

  openSection(section: DriveSection): void {
    if (section === 'drive') { this.openDrive(); return; }
    this.section.set(section);
    this.currentParent.set(null);
    this.breadcrumbs.set([]);
    this.activeShareRole.set(null);
    this.loading.set(true);
    if (section === 'shared') {
      this.cloud.getSharedWithMe().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (page) => {
          this.shareRoles.set(Object.fromEntries(page.items.map((item) => [item.node.id, item.role])));
          this.shareOwners.set(Object.fromEntries(page.items.map((item) => [item.node.id, item.user?.username ?? 'Usuario CloudFusion'])));
          this.nodes.set(page.items.map((item) => this.asVirtualNode(item)));
          this.loading.set(false);
        },
        error: () => this.fail('No se pudieron cargar los archivos compartidos contigo.'),
      });
      return;
    }
    const request = section === 'recent' ? this.cloud.getVirtualRecent() : section === 'favorites' ? this.cloud.getVirtualFavorites() : this.cloud.getVirtualTrash();
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (nodes) => { this.nodes.set(nodes); this.loading.set(false); }, error: () => this.fail('No se pudo cargar esta vista.') });
  }

  openFolder(node: VirtualNode): void {
    if (this.section() !== 'shared') this.section.set('drive');
    const directRole = this.shareRoles()[node.id];
    if (directRole) this.activeShareRole.set(directRole);
    this.loading.set(true);
    this.cloud.getVirtualChildren(node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (nodes) => { this.currentParent.set(node); this.breadcrumbs.update((items) => [...items, node]); this.nodes.set(nodes); this.loading.set(false); },
      error: () => this.fail('No se pudo abrir la carpeta.'),
    });
  }

  goTo(index: number): void {
    if (index < 0) { this.openSection(this.section() === 'shared' ? 'shared' : 'drive'); return; }
    const target = this.breadcrumbs()[index];
    if (!target) return;
    const directRole = this.shareRoles()[target.id];
    if (directRole) this.activeShareRole.set(directRole);
    this.loading.set(true);
    this.cloud.getVirtualChildren(target.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (nodes) => { this.currentParent.set(target); this.breadcrumbs.set(this.breadcrumbs().slice(0, index + 1)); this.nodes.set(nodes); this.loading.set(false); },
      error: () => this.fail('No se pudo abrir la carpeta.'),
    });
  }

  createFolder(): void {
    const name = window.prompt('Nombre de la carpeta');
    if (!name?.trim()) return;
    this.cloud.createVirtualFolder(name.trim(), this.currentParent()?.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.announce('Carpeta creada.'); this.reload(); }, error: () => this.fail('No se pudo crear la carpeta.') });
  }

  upload(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = '';
    if (!file) return;
    this.cloud.uploadVirtual(file, this.currentParent()?.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (result) => { this.announce(result.warning ?? (result.queued ? 'Archivo encolado para replicación.' : 'Archivo creado sin réplica física.')); this.reload(); }, error: () => this.fail('No se pudo iniciar la carga.') });
  }

  openVersions(node: VirtualNode): void {
    this.versionTarget.set(node);
    this.versionComment.set('');
    this.p2pSources.set({});
    this.p2pProgress.set(null);
    this.versionLoading.set(true);
    this.cloud.getFileVersions(node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (versions) => { this.versions.set(versions); this.versionLoading.set(false); },
      error: () => { this.versionLoading.set(false); this.fail('No se pudo cargar el historial de versiones.'); },
    });
  }

  closeVersions(): void { this.versionTarget.set(null); this.versions.set([]); this.p2pSources.set({}); this.p2pProgress.set(null); }

  uploadVersion(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const target = this.versionTarget();
    if (!file || !target) return;
    this.cloud.uploadFileVersion(target.id, file, this.versionComment()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (result) => {
        this.announce(result.queued ? `Versión ${result.version.versionNumber} guardada y encolada.` : `Versión ${result.version.versionNumber} guardada.`);
        this.openVersions(result.node);
        this.reload();
      },
      error: () => this.fail('No se pudo guardar la nueva versión.'),
    });
  }

  downloadVersion(version: FileVersionRecord): void {
    const target = this.versionTarget();
    if (!target) return;
    this.cloud.downloadFileVersion(target.id, version.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => this.saveDownload(blob, `${target.name}.v${version.versionNumber}`),
      error: () => this.fail('No se pudo descargar esa versión.'),
    });
  }

  restoreVersion(version: FileVersionRecord): void {
    const target = this.versionTarget();
    if (!target || version.current || !window.confirm(`¿Restaurar la versión ${version.versionNumber}? Se guardará como una versión nueva.`)) return;
    this.cloud.restoreFileVersion(target.id, version.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (node) => { this.announce(`La versión ${version.versionNumber} se restauró como una nueva versión.`); this.openVersions(node); this.reload(); },
      error: () => this.fail('No se pudo restaurar la versión.'),
    });
  }

  rename(node: VirtualNode): void {
    const name = window.prompt('Nuevo nombre', node.name);
    if (!name?.trim() || name.trim() === node.name) return;
    this.cloud.renameVirtual(node.id, name.trim()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.announce('Nombre actualizado.'); this.reload(); }, error: () => this.fail('No se pudo renombrar el elemento.') });
  }

  toggleFavorite(node: VirtualNode): void {
    this.cloud.setVirtualFavorite(node.id, !node.isFavorite).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.announce(node.isFavorite ? 'Quitado de favoritos.' : 'Añadido a favoritos.'); this.reload(); }, error: () => this.fail('No se pudo actualizar favoritos.') });
  }

  trash(node: VirtualNode): void {
    if (!window.confirm(`¿Enviar “${node.name}” a la papelera?`)) return;
    this.cloud.trashVirtual(node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.announce('Elemento enviado a la papelera.'); this.reload(); }, error: () => this.fail('No se pudo enviar a la papelera.') });
  }

  restore(node: VirtualNode): void {
    this.cloud.restoreVirtual(node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.announce('Elemento restaurado.'); this.reload(); }, error: () => this.fail('No se pudo restaurar el elemento.') });
  }

  permanentDelete(node: VirtualNode): void {
    if (!window.confirm(`¿Eliminar permanentemente “${node.name}”?`)) return;
    this.cloud.permanentDeleteVirtual(node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.announce('Elemento eliminado permanentemente.'); this.reload(); }, error: () => this.fail('No se pudo eliminar permanentemente.') });
  }

  rebalance(): void {
    this.cloud.rebalanceVirtual().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (result) => this.announce(`${result.queued} reparaciones encoladas.`), error: () => this.fail('No se pudo iniciar el rebalanceo.') });
  }

  download(node: VirtualNode): void {
    this.cloud.downloadVirtual(node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => this.saveDownload(blob, node.name),
      error: () => this.fail('No hay una réplica disponible para descargar.'),
    });
  }

  openShareDialog(node: VirtualNode): void {
    this.shareTarget.set(node);
    this.shareEmail.set('');
    this.shareRole.set('VIEWER');
    this.shareQuery.set('');
    this.shareUsers.set([]);
    this.shareInvitations.set([]);
    this.invitationToken.set(null);
    this.invitationExpiresAt.set(null);
    this.publicPassword.set('');
    this.publicDownloadLimit.set('');
    this.publicLink.set(null);
    this.publicShares.set([]);
    this.shareError.set(null);
    this.shareBusy.set(true);
    this.cloud.getSharesCreated(1, 100, node.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (page) => { this.shareEntries.set(page.items); this.shareBusy.set(false); },
      error: () => { this.shareEntries.set([]); this.shareBusy.set(false); this.shareError.set('No se pudo cargar la lista de personas.'); },
    });
    this.loadShareInvitations(node.id);
    if (node.type === 'FILE') this.loadPublicShares(node.id);
  }

  closeShareDialog(): void {
    this.shareTarget.set(null);
    this.shareEntries.set([]);
    this.shareInvitations.set([]);
    this.shareUsers.set([]);
    this.shareError.set(null);
    this.invitationToken.set(null);
    this.invitationExpiresAt.set(null);
    this.publicLink.set(null);
  }

  searchShareUsers(): void {
    const query = this.shareQuery().trim();
    if (query.length < 2) { this.shareError.set('Escribe al menos 2 caracteres para buscar.'); return; }
    this.shareBusy.set(true);
    this.shareError.set(null);
    this.cloud.searchShareUsers(query).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (result) => { this.shareUsers.set(result.items); this.shareBusy.set(false); },
      error: () => { this.shareUsers.set([]); this.shareBusy.set(false); this.shareError.set('No se pudo buscar el usuario.'); },
    });
  }

  chooseShareUser(user: ShareUser): void {
    this.shareEmail.set(user.email);
    this.shareUsers.set([]);
    this.shareQuery.set(user.email);
  }

  createShare(): void {
    const target = this.shareTarget();
    const email = this.shareEmail().trim();
    if (!target || !email) { this.shareError.set('Escribe el correo de una cuenta CloudFusion.'); return; }
    this.shareBusy.set(true);
    this.shareError.set(null);
    this.cloud.createResourceShare(target.id, email, this.shareRole()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.shareEmail.set('');
        this.shareUsers.set([]);
        this.loadShareEntries(target.id);
      },
      error: () => { this.shareBusy.set(false); this.shareError.set('No se pudo compartir. Revisa que el correo pertenezca a una cuenta activa de CloudFusion.'); },
    });
  }

  createShareInvitation(): void {
    const target = this.shareTarget();
    const email = this.shareEmail().trim();
    if (!target || !email) { this.shareError.set('Escribe el correo de la persona que quieres invitar.'); return; }
    this.shareBusy.set(true);
    this.shareError.set(null);
    this.cloud.createShareInvitation(target.id, email, this.shareRole()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (invitation: CreateShareInvitationResult) => {
        this.invitationToken.set(invitation.token);
        this.invitationExpiresAt.set(invitation.expiresAt);
        this.shareBusy.set(false);
        this.loadShareInvitations(target.id);
      },
      error: () => { this.shareBusy.set(false); this.shareError.set('No se pudo crear la invitación. Si la persona ya tiene cuenta, compártelo directamente.'); },
    });
  }

  revokeInvitation(invitation: ShareInvitationRecord): void {
    if (!window.confirm(`¿Cancelar la invitación enviada a ${invitation.email}?`)) return;
    this.cloud.revokeShareInvitation(invitation.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { const target = this.shareTarget(); if (target) this.loadShareInvitations(target.id); },
      error: () => this.shareError.set('No se pudo cancelar la invitación.'),
    });
  }

  createPublicShare(): void {
    const target = this.shareTarget();
    if (!target || target.type !== 'FILE') return;
    const rawLimit = this.publicDownloadLimit().trim();
    const downloadLimit = rawLimit ? Number(rawLimit) : undefined;
    if (rawLimit && (!Number.isSafeInteger(downloadLimit) || (downloadLimit ?? 0) < 1)) {
      this.shareError.set('El límite de descargas debe ser un número entero mayor que cero.');
      return;
    }
    const password = this.publicPassword();
    if (password && password.length < 8) {
      this.shareError.set('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    this.shareBusy.set(true);
    this.shareError.set(null);
    this.cloud.createPublicShare(target.id, this.publicPermission(), this.publicExpiry(), password || undefined, downloadLimit)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (link) => {
          this.publicLink.set(link);
          this.publicPassword.set('');
          this.shareBusy.set(false);
          this.loadPublicShares(target.id);
        },
        error: () => {
          this.shareBusy.set(false);
          this.shareError.set('No se pudo crear el enlace. Comprueba que el archivo siga disponible y que la configuración sea válida.');
        },
      });
  }

  revokePublicShare(share: PublicShareRecord): void {
    if (!window.confirm(`¿Desactivar el enlace público de “${share.node.name}”?`)) return;
    this.cloud.revokePublicShare(share.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { const target = this.shareTarget(); if (target) this.loadPublicShares(target.id); },
      error: () => this.shareError.set('No se pudo desactivar el enlace público.'),
    });
  }

  async copyPublicLink(): Promise<void> {
    const url = this.publicLink()?.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.announce('Enlace copiado al portapapeles.');
    } catch {
      this.shareError.set('No se pudo copiar automáticamente. Selecciona y copia el enlace.');
    }
  }

  setPublicExpiry(value: string): void {
    const allowed: PublicShareExpiry[] = ['1_DAY', '7_DAYS', '30_DAYS', 'NEVER'];
    if (allowed.includes(value as PublicShareExpiry)) this.publicExpiry.set(value as PublicShareExpiry);
  }

  acceptInvitation(): void {
    const token = this.invitationAcceptToken().trim();
    if (!token) { this.invitationAcceptError.set('Pega el código de invitación.'); return; }
    this.invitationAcceptBusy.set(true);
    this.invitationAcceptError.set(null);
    this.cloud.acceptShareInvitation(token).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (share) => {
        this.invitationAcceptBusy.set(false);
        this.invitationAcceptToken.set('');
        this.announce(`Aceptaste la invitación para “${share.node.name}”.`);
        this.openSection('shared');
      },
      error: () => {
        this.invitationAcceptBusy.set(false);
        this.invitationAcceptError.set('No se pudo aceptar. Comprueba que el código esté vigente y que tu cuenta use el correo invitado.');
      },
    });
  }

  changeShareRole(entry: ResourceShareRecord, event: Event): void {
    const role = (event.target as HTMLSelectElement).value as ResourceShareRole;
    this.cloud.updateResourceShare(entry.id, role).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.loadShareEntries(entry.node.id),
      error: () => this.shareError.set('No se pudo cambiar el permiso.'),
    });
  }

  revokeShare(entry: ResourceShareRecord): void {
    if (!window.confirm(`¿Quitar el acceso de ${entry.user?.email ?? 'esta persona'}?`)) return;
    this.cloud.revokeResourceShare(entry.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.loadShareEntries(entry.node.id),
      error: () => this.shareError.set('No se pudo revocar el acceso.'),
    });
  }

  canWriteNode(node: VirtualNode): boolean {
    if (this.section() !== 'shared') return this.section() === 'drive';
    return (this.shareRoles()[node.id] ?? this.activeShareRole()) === 'EDITOR';
  }

  canWriteCurrentFolder(): boolean {
    return this.section() === 'drive' || (this.section() === 'shared' && this.activeShareRole() === 'EDITOR');
  }

  private loadShareEntries(nodeId: string): void {
    this.cloud.getSharesCreated(1, 100, nodeId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (page) => { this.shareEntries.set(page.items); this.shareBusy.set(false); },
      error: () => { this.shareBusy.set(false); this.shareError.set('No se pudo actualizar la lista de personas.'); },
    });
  }

  private loadShareInvitations(nodeId: string): void {
    this.cloud.listShareInvitations(1, 100).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (page) => this.shareInvitations.set(page.items.filter((invitation) => invitation.node?.id === nodeId && !invitation.acceptedAt && !invitation.revokedAt && new Date(invitation.expiresAt).getTime() > Date.now())),
      error: () => this.shareInvitations.set([]),
    });
  }

  private loadPublicShares(nodeId: string): void {
    this.cloud.listPublicShares(1, 100, nodeId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (page) => this.publicShares.set(page.items),
      error: () => this.shareError.set('No se pudieron cargar los enlaces públicos.'),
    });
  }

  private asVirtualNode(entry: ResourceShareRecord): VirtualNode {
    return {
      ...entry.node,
      userId: entry.user?.id ?? '',
      workspaceId: null,
      status: 'AVAILABLE',
      storageObjectId: null,
      currentVersionId: null,
      isRoot: false,
      isFavorite: false,
      deletedAt: null,
      lastAccessedAt: null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  private saveDownload(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  formatBytes(value: number | null): string {
    if (!value) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
  }

  statusLabel(status: VirtualNode['status']): string { return ({ AVAILABLE: 'Disponible', UPLOADING: 'Subiendo', DEGRADED: 'Degradado', UNAVAILABLE: 'Sin réplica', DELETING: 'En papelera', ERROR: 'Error' } satisfies Record<VirtualNode['status'], string>)[status]; }
  isTrash(): boolean { return this.section() === 'trash'; }
  title(): string { return ({ drive: 'Mi Drive', recent: 'Recientes', favorites: 'Favoritos', shared: 'Compartido conmigo', trash: 'Papelera' } as Record<DriveSection, string>)[this.section()]; }
  p2pProgressPercent(): number {
    const progress = this.p2pProgress();
    if (!progress) return 0;
    const total = Number(progress.totalBytes);
    return total === 0
      ? progress.status.startsWith('COMPLETED') ? 100 : 0
      : Math.min(100, Math.floor((Number(progress.bytesTransferred) / total) * 100));
  }

  p2pProgressText(): string {
    const progress = this.p2pProgress();
    if (!progress) return '';
    return `${this.formatP2pBytes(Number(progress.bytesTransferred))} / ${this.formatP2pBytes(Number(progress.totalBytes))}`;
  }

  private formatP2pBytes(value: number): string { return value === 0 ? '0 B' : this.formatBytes(value); }

  private listenForP2pProgress(): void {
    if (typeof window === 'undefined') return;
    const events = (window as DesktopInvokeWindow).__TAURI__?.event;
    if (!events) return;
    void events.listen<P2pTransferProgress>('p2p-transfer-progress', ({ payload }) => {
      if (this.p2pProgress()?.transferId === payload.transferId) this.p2pProgress.set(payload);
    }).then((stop) => this.destroyRef.onDestroy(stop));
    this.meshPeerListenerReady = events.listen<P2pMeshPeerUpdate>('mesh-peer-update', ({ payload }) => {
      this.meshPeerStatuses.update((statuses) => ({ ...statuses, [payload.peerId]: payload.status }));
    }).then((stop) => {
      this.destroyRef.onDestroy(stop);
    }).catch(() => undefined);
  }

  private async startMeshForActiveDesktopDevice(): Promise<void> {
    const deviceId = this.auth.deviceId;
    const accessToken = this.auth.accessToken;
    if (!this.desktopSyncAvailable || !deviceId || !accessToken) return;
    try {
      await this.meshPeerListenerReady;
      const [devices, peers] = await Promise.all([
        firstValueFrom(this.http.get<ApiResponse<RegisteredP2pDevice[]>>(`${this.apiUrl}/devices`)),
        firstValueFrom(this.http.get<ApiResponse<TrustedP2pPeer[]>>(`${this.apiUrl}/devices/mesh-peers`)),
      ]);
      const current = devices.data.find((device) => device.id === deviceId);
      if (!current?.p2pEnabled || (!current.lanDiscoveryEnabled && !current.internetP2pEnabled)) return;
      await this.invokeDesktop<void>('configure_mesh_api', { apiUrl: this.apiUrl, accessToken });
      await this.invokeDesktop<void>('set_trusted_mesh_peers', { peerIds: peers.data.map((peer) => peer.peerId) });
      await this.invokeDesktop<void>('start_lan_mesh', {
        lanDiscoveryEnabled: current.lanDiscoveryEnabled,
        internetP2pEnabled: current.internetP2pEnabled,
        relayAllowed: current.relayAllowed,
      });
    } catch {
      // The cloud download action remains available when this device cannot join the LAN mesh.
    }
  }

  private invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const invoke = (window as DesktopInvokeWindow).__TAURI__?.core?.invoke;
    return invoke
      ? invoke<T>(command, args)
      : Promise.reject(new Error('CloudFusion Desktop is not available'));
  }

  private loadChildren(root: VirtualNode): void { this.cloud.getVirtualChildren(root.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (nodes) => { this.nodes.set(nodes); this.loading.set(false); }, error: () => this.fail('No se pudo cargar el contenido.') }); }
  private reload(): void { this.section() === 'drive' ? (this.currentParent() ? this.loadChildren(this.currentParent() as VirtualNode) : this.openDrive()) : this.openSection(this.section()); }
  private announce(message: string): void { this.notice.set(message); this.error.set(null); }
  private fail(message: string): void { this.loading.set(false); this.error.set(message); }
}
