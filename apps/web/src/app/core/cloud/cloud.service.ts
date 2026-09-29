import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, map } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api-response.model';
import { BackupJobRecord, BackupPolicyRecord, CloudAccount, CloudAccountImpactRecord, CloudFile, CloudProvider, CloudSearchResponse, CloudStorageSummary, ConnectS3AccountInput, CreatePublicShareResult, CreateShareInvitationResult, CreateWorkspaceInvitationResult, DataProtectionEventRecord, FileVersionRecord, ProviderConnectionTestResult, ProviderDescriptor, ProtectionAlertRecord, ProtectionOverviewRecord, PublicShareExpiry, PublicShareInfo, PublicSharePage, PublicSharePermission, PublicShareRecord, ResourceShareRecord, ResourceShareRole, S3TargetInput, ShareInvitationPage, SharePage, ShareUserSearchResult, SnapshotEntryRecord, SnapshotRecord, SnapshotRestoreJobRecord, StorageRule, StorageTargetRecord, TransferJob, TransferProgressEvent, TransferOperation, VirtualNode, WorkspaceInvitationRecord, WorkspaceMemberRecord, WorkspacePage, WorkspaceRecord, WorkspaceRole } from '../../shared/models/cloud.model';

@Injectable({ providedIn: 'root' })
export class CloudService {
  private readonly apiUrl = environment.apiUrl;

  constructor(private readonly http: HttpClient, private readonly auth: AuthService) {}

  getAccounts(): Observable<CloudAccount[]> {
    return this.http.get<ApiResponse<CloudAccount[]>>(`${this.apiUrl}/cloud-accounts`).pipe(map((response) => response.data));
  }

  getProviders(): Observable<ProviderDescriptor[]> {
    return this.http.get<ApiResponse<ProviderDescriptor[]>>(`${this.apiUrl}/providers`).pipe(map((response) => response.data));
  }

  testS3Connection(input: ConnectS3AccountInput): Observable<ProviderConnectionTestResult> {
    return this.http.post<ApiResponse<ProviderConnectionTestResult>>(`${this.apiUrl}/cloud-accounts/s3/test-connection`, input).pipe(map((response) => response.data));
  }

  connectS3Account(input: ConnectS3AccountInput): Observable<{ account: CloudAccount; target: StorageTargetRecord; health: ProviderConnectionTestResult }> {
    return this.http.post<ApiResponse<{ account: CloudAccount; target: StorageTargetRecord; health: ProviderConnectionTestResult }>>(`${this.apiUrl}/cloud-accounts/s3/connect`, input).pipe(map((response) => response.data));
  }

  getStorageTargets(accountId: string): Observable<StorageTargetRecord[]> {
    return this.http.get<ApiResponse<StorageTargetRecord[]>>(`${this.apiUrl}/cloud-accounts/s3/${accountId}/targets`).pipe(map((response) => response.data));
  }

  addStorageTarget(accountId: string, input: S3TargetInput & { name?: string }): Observable<{ target: StorageTargetRecord; health: ProviderConnectionTestResult }> {
    return this.http.post<ApiResponse<{ target: StorageTargetRecord; health: ProviderConnectionTestResult }>>(`${this.apiUrl}/cloud-accounts/s3/${accountId}/targets`, input).pipe(map((response) => response.data));
  }

  testStorageTarget(accountId: string, targetId: string, verifyWrite = false): Observable<ProviderConnectionTestResult> {
    return this.http.post<ApiResponse<ProviderConnectionTestResult>>(`${this.apiUrl}/cloud-accounts/s3/${accountId}/targets/${targetId}/test-connection`, { verifyWrite }).pipe(map((response) => response.data));
  }

  getStorageSummary(): Observable<CloudStorageSummary> {
    return this.http.get<ApiResponse<CloudStorageSummary>>(`${this.apiUrl}/cloud-accounts/storage-summary`).pipe(map((response) => response.data));
  }

  listFiles(accountId?: string, parentId?: string): Observable<CloudFile[]> {
    let params = new HttpParams();
    if (accountId) params = params.set('accountId', accountId);
    if (parentId) params = params.set('parentId', parentId);
    return this.http.get<ApiResponse<CloudFile[]>>(`${this.apiUrl}/cloud-files`, { params }).pipe(map((response) => response.data));
  }

  createFolder(accountId: string, name: string, parentId?: string): Observable<CloudFile> {
    return this.http.post<ApiResponse<CloudFile>>(`${this.apiUrl}/cloud-files/${accountId}/folders`, { name, parentId }).pipe(map((response) => response.data));
  }

  rename(accountId: string, fileId: string, name: string): Observable<CloudFile> {
    return this.http.patch<ApiResponse<CloudFile>>(`${this.apiUrl}/cloud-files/${accountId}/${fileId}`, { name }).pipe(map((response) => response.data));
  }

  remove(accountId: string, fileId: string): Observable<{ deleted: true }> {
    return this.http.delete<ApiResponse<{ deleted: true }>>(`${this.apiUrl}/cloud-files/${accountId}/${fileId}`).pipe(map((response) => response.data));
  }

  upload(accountId: string, file: File, parentId?: string): Observable<CloudFile> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (parentId) form.append('parentId', parentId);
    return this.http.post<ApiResponse<CloudFile>>(`${this.apiUrl}/cloud-files/${accountId}/upload`, form).pipe(map((response) => response.data));
  }

  download(accountId: string, fileId: string): Observable<Blob> {
    return this.http.get(`${this.apiUrl}/cloud-files/${accountId}/${fileId}/download`, { responseType: 'blob' });
  }

  connect(provider: CloudProvider): Observable<string> {
    const providerPath = ({ GOOGLE_DRIVE: 'google', ONEDRIVE: 'onedrive', DROPBOX: 'dropbox', BOX: 'box' } as const)[provider as 'GOOGLE_DRIVE' | 'ONEDRIVE' | 'DROPBOX' | 'BOX'];
    if (!providerPath) throw new Error(`OAuth connection is not supported for ${provider}`);
    return this.http.post<ApiResponse<{ authorizationUrl: string }>>(`${this.apiUrl}/cloud-accounts/${providerPath}/connect`, {})
      .pipe(map((response) => response.data.authorizationUrl));
  }

  refreshAccount(accountId: string): Observable<CloudAccount> {
    return this.http.post<ApiResponse<CloudAccount>>(`${this.apiUrl}/cloud-accounts/${accountId}/refresh`, {}).pipe(map((response) => response.data));
  }

  getAccountImpact(accountId: string): Observable<CloudAccountImpactRecord> {
    return this.http.get<ApiResponse<CloudAccountImpactRecord>>(`${this.apiUrl}/cloud-accounts/${accountId}/impact`).pipe(map((response) => response.data));
  }

  disconnect(accountId: string, confirmImpact = false): Observable<{ disconnected: true }> {
    const params = confirmImpact ? new HttpParams().set('confirmImpact', 'true') : undefined;
    return this.http.delete<ApiResponse<{ disconnected: true }>>(`${this.apiUrl}/cloud-accounts/${accountId}`, { params }).pipe(map((response) => response.data));
  }

  createTransfer(input: { sourceAccountId: string; sourceFileId: string; destinationAccountId: string; destinationFolderId?: string; operation: TransferOperation; conflictStrategy?: string }): Observable<TransferJob> {
    return this.http.post<ApiResponse<TransferJob>>(`${this.apiUrl}/transfers`, input).pipe(map((response) => response.data));
  }

  getTransfers(status?: string): Observable<TransferJob[]> {
    const params = status ? new HttpParams().set('status', status) : undefined;
    return this.http.get<ApiResponse<TransferJob[]>>(`${this.apiUrl}/transfers`, { params }).pipe(map((response) => response.data));
  }

  cancelTransfer(id: string): Observable<TransferJob> {
    return this.http.post<ApiResponse<TransferJob>>(`${this.apiUrl}/transfers/${id}/cancel`, {}).pipe(map((response) => response.data));
  }

  retryTransfer(id: string): Observable<TransferJob> {
    return this.http.post<ApiResponse<TransferJob>>(`${this.apiUrl}/transfers/${id}/retry`, {}).pipe(map((response) => response.data));
  }

  deleteTransfer(id: string): Observable<{ deleted: true }> {
    return this.http.delete<ApiResponse<{ deleted: true }>>(`${this.apiUrl}/transfers/${id}`).pipe(map((response) => response.data));
  }

  streamTransfer(id: string): Observable<TransferProgressEvent> {
    return new Observable<TransferProgressEvent>((subscriber) => {
      const controller = new AbortController();
      const token = this.auth.accessToken;
      void fetch(`${this.apiUrl}/transfers/${id}/events`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok || !response.body) throw new Error('Transfer event stream unavailable');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const messages = buffer.split('\n\n');
          buffer = messages.pop() ?? '';
          for (const message of messages) {
            const data = message.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim();
            if (data) subscriber.next(JSON.parse(data) as TransferProgressEvent);
          }
        }
        subscriber.complete();
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) subscriber.error(error);
      });
      return () => controller.abort();
    });
  }

  search(query: string): Observable<CloudSearchResponse> {
    return this.http.get<ApiResponse<CloudSearchResponse>>(`${this.apiUrl}/cloud-search`, { params: new HttpParams().set('q', query) }).pipe(map((response) => response.data));
  }

  listRules(): Observable<StorageRule[]> {
    return this.http.get<ApiResponse<StorageRule[]>>(`${this.apiUrl}/storage-rules`).pipe(map((response) => response.data));
  }

  createRule(rule: { name: string; priority: number; enabled?: boolean; conditionType: StorageRule['conditionType']; conditionValue?: string; destinationAccountId: string; destinationFolderId?: string }): Observable<StorageRule> {
    return this.http.post<ApiResponse<StorageRule>>(`${this.apiUrl}/storage-rules`, rule).pipe(map((response) => response.data));
  }

  updateRule(id: string, rule: Partial<StorageRule>): Observable<StorageRule> {
    return this.http.patch<ApiResponse<StorageRule>>(`${this.apiUrl}/storage-rules/${id}`, rule).pipe(map((response) => response.data));
  }

  deleteRule(id: string): Observable<{ deleted: true }> {
    return this.http.delete<ApiResponse<{ deleted: true }>>(`${this.apiUrl}/storage-rules/${id}`).pipe(map((response) => response.data));
  }

  smartUpload(file: File, parentId?: string): Observable<{ file: CloudFile; destination: { accountId: string; provider: string; folderId: string | null; ruleId: string | null } }> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (parentId) form.append('parentId', parentId);
    return this.http.post<ApiResponse<{ file: CloudFile; destination: { accountId: string; provider: string; folderId: string | null; ruleId: string | null } }>>(`${this.apiUrl}/cloud-files/smart-upload`, form).pipe(map((response) => response.data));
  }

  getVirtualRoot(): Observable<VirtualNode> {
    return this.http.get<ApiResponse<VirtualNode>>(`${this.apiUrl}/virtual-drive/root`).pipe(map((response) => response.data));
  }

  getVirtualChildren(parentId: string): Observable<VirtualNode[]> {
    return this.http.get<ApiResponse<VirtualNode[]>>(`${this.apiUrl}/virtual-drive/nodes/${parentId}/children`).pipe(map((response) => response.data));
  }

  getSharedWithMe(page = 1, limit = 25): Observable<SharePage> {
    const params = new HttpParams().set('page', page).set('limit', limit);
    return this.http.get<ApiResponse<SharePage>>(`${this.apiUrl}/shares/received`, { params }).pipe(map((response) => response.data));
  }

  getSharesCreated(page = 1, limit = 100, nodeId?: string): Observable<SharePage> {
    let params = new HttpParams().set('page', page).set('limit', limit);
    if (nodeId) params = params.set('nodeId', nodeId);
    return this.http.get<ApiResponse<SharePage>>(`${this.apiUrl}/shares/created`, { params }).pipe(map((response) => response.data));
  }

  searchShareUsers(query: string, page = 1): Observable<ShareUserSearchResult> {
    const params = new HttpParams().set('q', query).set('page', page).set('limit', 10);
    return this.http.get<ApiResponse<ShareUserSearchResult>>(`${this.apiUrl}/shares/users`, { params }).pipe(map((response) => response.data));
  }

  createResourceShare(nodeId: string, email: string, role: ResourceShareRole): Observable<ResourceShareRecord> {
    return this.http.post<ApiResponse<ResourceShareRecord>>(`${this.apiUrl}/shares`, { nodeId, email, role }).pipe(map((response) => response.data));
  }

  updateResourceShare(id: string, role: ResourceShareRole): Observable<ResourceShareRecord> {
    return this.http.patch<ApiResponse<ResourceShareRecord>>(`${this.apiUrl}/shares/${id}`, { role }).pipe(map((response) => response.data));
  }

  revokeResourceShare(id: string): Observable<{ revoked: true }> {
    return this.http.delete<ApiResponse<{ revoked: true }>>(`${this.apiUrl}/shares/${id}`).pipe(map((response) => response.data));
  }

  createShareInvitation(nodeId: string, email: string, role: ResourceShareRole): Observable<CreateShareInvitationResult> {
    return this.http.post<ApiResponse<CreateShareInvitationResult>>(`${this.apiUrl}/shares/invitations`, { nodeId, email, role }).pipe(map((response) => response.data));
  }

  listShareInvitations(page = 1, limit = 25): Observable<ShareInvitationPage> {
    const params = new HttpParams().set('page', page).set('limit', limit);
    return this.http.get<ApiResponse<ShareInvitationPage>>(`${this.apiUrl}/shares/invitations`, { params }).pipe(map((response) => response.data));
  }

  revokeShareInvitation(id: string): Observable<{ revoked: true }> {
    return this.http.delete<ApiResponse<{ revoked: true }>>(`${this.apiUrl}/shares/invitations/${id}`).pipe(map((response) => response.data));
  }

  acceptShareInvitation(token: string): Observable<ResourceShareRecord> {
    return this.http.post<ApiResponse<ResourceShareRecord>>(`${this.apiUrl}/shares/invitations/accept`, { token }).pipe(map((response) => response.data));
  }

  createPublicShare(nodeId: string, permission: PublicSharePermission, expiry: PublicShareExpiry, password?: string, downloadLimit?: number): Observable<CreatePublicShareResult> {
    return this.http.post<ApiResponse<CreatePublicShareResult>>(`${this.apiUrl}/public-shares`, { nodeId, permission, expiry, password, downloadLimit }).pipe(map((response) => response.data));
  }

  listPublicShares(page = 1, limit = 100, nodeId?: string): Observable<PublicSharePage> {
    let params = new HttpParams().set('page', page).set('limit', limit);
    if (nodeId) params = params.set('nodeId', nodeId);
    return this.http.get<ApiResponse<PublicSharePage>>(`${this.apiUrl}/public-shares`, { params }).pipe(map((response) => response.data));
  }

  revokePublicShare(id: string): Observable<{ revoked: true }> {
    return this.http.delete<ApiResponse<{ revoked: true }>>(`${this.apiUrl}/public-shares/${id}`).pipe(map((response) => response.data));
  }

  getPublicShare(token: string): Observable<PublicShareInfo> {
    return this.http.get<ApiResponse<PublicShareInfo>>(`${this.apiUrl}/s/${token}`).pipe(map((response) => response.data));
  }

  accessPublicShare(token: string, password: string): Observable<PublicShareInfo> {
    return this.http.post<ApiResponse<PublicShareInfo>>(`${this.apiUrl}/s/${token}/access`, { password }).pipe(map((response) => response.data));
  }

  downloadPublicShare(token: string, password?: string): Observable<Blob> {
    return this.http.post(`${this.apiUrl}/s/${token}/download`, { password }, { responseType: 'blob' });
  }

  listWorkspaces(page = 1, limit = 25): Observable<WorkspacePage> {
    const params = new HttpParams().set('page', page).set('limit', limit);
    return this.http.get<ApiResponse<WorkspacePage>>(`${this.apiUrl}/workspaces`, { params }).pipe(map((response) => response.data));
  }

  createWorkspace(name: string, description?: string): Observable<WorkspaceRecord> {
    return this.http.post<ApiResponse<WorkspaceRecord>>(`${this.apiUrl}/workspaces`, { name, description }).pipe(map((response) => response.data));
  }

  getWorkspaceMembers(workspaceId: string, page = 1, limit = 100): Observable<{ items: WorkspaceMemberRecord[]; page: number; limit: number; total: number }> {
    const params = new HttpParams().set('page', page).set('limit', limit);
    return this.http.get<ApiResponse<{ items: WorkspaceMemberRecord[]; page: number; limit: number; total: number }>>(`${this.apiUrl}/workspaces/${workspaceId}/members`, { params }).pipe(map((response) => response.data));
  }

  getWorkspaceDriveRoot(workspaceId: string): Observable<VirtualNode> {
    return this.http.get<ApiResponse<VirtualNode>>(`${this.apiUrl}/workspaces/${workspaceId}/drive/root`).pipe(map((response) => response.data));
  }

  getWorkspaceDriveChildren(workspaceId: string, nodeId: string): Observable<VirtualNode[]> {
    return this.http.get<ApiResponse<VirtualNode[]>>(`${this.apiUrl}/workspaces/${workspaceId}/drive/nodes/${nodeId}/children`).pipe(map((response) => response.data));
  }

  createWorkspaceFolder(workspaceId: string, name: string, parentId?: string): Observable<VirtualNode> {
    return this.http.post<ApiResponse<VirtualNode>>(`${this.apiUrl}/workspaces/${workspaceId}/drive/folders`, { name, parentId }).pipe(map((response) => response.data));
  }

  uploadWorkspaceFile(workspaceId: string, file: File, parentId?: string): Observable<{ node: VirtualNode; queued: boolean; replicas: number; warning?: string }> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (parentId) form.append('parentId', parentId);
    return this.http.post<ApiResponse<{ node: VirtualNode; queued: boolean; replicas: number; warning?: string }>>(`${this.apiUrl}/workspaces/${workspaceId}/drive/upload`, form).pipe(map((response) => response.data));
  }

  createWorkspaceInvitation(workspaceId: string, email: string, role: WorkspaceRole): Observable<CreateWorkspaceInvitationResult> {
    return this.http.post<ApiResponse<CreateWorkspaceInvitationResult>>(`${this.apiUrl}/workspaces/${workspaceId}/invitations`, { email, role }).pipe(map((response) => response.data));
  }

  acceptWorkspaceInvitation(token: string): Observable<{ workspaceId: string; userId: string; role: WorkspaceRole; joinedAt: string }> {
    return this.http.post<ApiResponse<{ workspaceId: string; userId: string; role: WorkspaceRole; joinedAt: string }>>(`${this.apiUrl}/workspaces/invitations/accept`, { token }).pipe(map((response) => response.data));
  }

  updateWorkspaceMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Observable<{ userId: string; role: WorkspaceRole }> {
    return this.http.patch<ApiResponse<{ userId: string; role: WorkspaceRole }>>(`${this.apiUrl}/workspaces/${workspaceId}/members/${userId}`, { role }).pipe(map((response) => response.data));
  }

  removeWorkspaceMember(workspaceId: string, userId: string): Observable<{ removed: true }> {
    return this.http.delete<ApiResponse<{ removed: true }>>(`${this.apiUrl}/workspaces/${workspaceId}/members/${userId}`).pipe(map((response) => response.data));
  }

  createVirtualFolder(name: string, parentId?: string): Observable<VirtualNode> {
    return this.http.post<ApiResponse<VirtualNode>>(`${this.apiUrl}/virtual-drive/folders`, { name, parentId }).pipe(map((response) => response.data));
  }

  uploadVirtual(file: File, parentId?: string): Observable<{ node: VirtualNode; queued: boolean; replicas: number; warning?: string }> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (parentId) form.append('parentId', parentId);
    return this.http.post<ApiResponse<{ node: VirtualNode; queued: boolean; replicas: number; warning?: string }>>(`${this.apiUrl}/virtual-drive/upload`, form).pipe(map((response) => response.data));
  }

  renameVirtual(id: string, name: string): Observable<VirtualNode> {
    return this.http.patch<ApiResponse<VirtualNode>>(`${this.apiUrl}/virtual-drive/nodes/${id}`, { name }).pipe(map((response) => response.data));
  }

  trashVirtual(id: string): Observable<{ deleted: true }> {
    return this.http.delete<ApiResponse<{ deleted: true }>>(`${this.apiUrl}/virtual-drive/nodes/${id}`).pipe(map((response) => response.data));
  }

  restoreVirtual(id: string): Observable<VirtualNode> {
    return this.http.post<ApiResponse<VirtualNode>>(`${this.apiUrl}/virtual-drive/nodes/${id}/restore`, {}).pipe(map((response) => response.data));
  }

  permanentDeleteVirtual(id: string): Observable<{ deleted: true }> {
    return this.http.delete<ApiResponse<{ deleted: true }>>(`${this.apiUrl}/virtual-drive/nodes/${id}/permanent`).pipe(map((response) => response.data));
  }

  getVirtualRecent(): Observable<VirtualNode[]> {
    return this.http.get<ApiResponse<VirtualNode[]>>(`${this.apiUrl}/virtual-drive/recent`).pipe(map((response) => response.data));
  }

  getVirtualFavorites(): Observable<VirtualNode[]> {
    return this.http.get<ApiResponse<VirtualNode[]>>(`${this.apiUrl}/virtual-drive/favorites`).pipe(map((response) => response.data));
  }

  getVirtualTrash(): Observable<VirtualNode[]> {
    return this.http.get<ApiResponse<VirtualNode[]>>(`${this.apiUrl}/virtual-drive/trash`).pipe(map((response) => response.data));
  }

  setVirtualFavorite(id: string, favorite: boolean): Observable<VirtualNode> {
    const request = favorite ? this.http.post<ApiResponse<VirtualNode>>(`${this.apiUrl}/virtual-drive/nodes/${id}/favorite`, {}) : this.http.delete<ApiResponse<VirtualNode>>(`${this.apiUrl}/virtual-drive/nodes/${id}/favorite`);
    return request.pipe(map((response) => response.data));
  }

  downloadVirtual(id: string): Observable<Blob> {
    return this.http.get(`${this.apiUrl}/virtual-drive/nodes/${id}/download`, { responseType: 'blob' });
  }

  getFileVersions(id: string): Observable<FileVersionRecord[]> {
    return this.http.get<ApiResponse<FileVersionRecord[]>>(`${this.apiUrl}/virtual-drive/nodes/${id}/versions`).pipe(map((response) => response.data));
  }

  uploadFileVersion(id: string, file: File, comment?: string): Observable<{ node: VirtualNode; version: FileVersionRecord; queued: boolean; replicas: number }> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (comment?.trim()) form.append('comment', comment.trim());
    return this.http.post<ApiResponse<{ node: VirtualNode; version: FileVersionRecord; queued: boolean; replicas: number }>>(`${this.apiUrl}/virtual-drive/nodes/${id}/versions`, form).pipe(map((response) => response.data));
  }

  restoreFileVersion(id: string, versionId: string): Observable<VirtualNode> {
    return this.http.post<ApiResponse<VirtualNode>>(`${this.apiUrl}/virtual-drive/nodes/${id}/versions/${versionId}/restore`, {}).pipe(map((response) => response.data));
  }

  downloadFileVersion(id: string, versionId: string): Observable<Blob> {
    return this.http.get(`${this.apiUrl}/virtual-drive/nodes/${id}/versions/${versionId}/download`, { responseType: 'blob' });
  }

  listSnapshots(): Observable<SnapshotRecord[]> {
    return this.http.get<ApiResponse<SnapshotRecord[]>>(`${this.apiUrl}/snapshots`).pipe(map((response) => response.data));
  }

  createSnapshot(name: string, description?: string, isImmutable = false): Observable<SnapshotRecord> {
    return this.http.post<ApiResponse<SnapshotRecord>>(`${this.apiUrl}/snapshots`, { name, description, isImmutable }).pipe(map((response) => response.data));
  }

  getSnapshotEntries(id: string): Observable<SnapshotEntryRecord[]> {
    return this.http.get<ApiResponse<SnapshotEntryRecord[]>>(`${this.apiUrl}/snapshots/${id}/entries`).pipe(map((response) => response.data));
  }

  restoreSnapshotEntry(snapshotId: string, entryId: string, strategy: 'RESTORE_RENAME' | 'RESTORE_OVERWRITE' | 'RESTORE_SKIP' = 'RESTORE_RENAME', targetParentId?: string): Observable<{ status: 'RESTORED' | 'SKIPPED'; nodeId?: string; name?: string }> {
    return this.http.post<ApiResponse<{ status: 'RESTORED' | 'SKIPPED'; nodeId?: string; name?: string }>>(`${this.apiUrl}/snapshots/${snapshotId}/entries/${entryId}/restore`, { strategy, targetParentId }).pipe(map((response) => response.data));
  }

  restoreSnapshot(id: string): Observable<SnapshotRestoreJobRecord> {
    return this.http.post<ApiResponse<SnapshotRestoreJobRecord>>(`${this.apiUrl}/snapshots/${id}/restore`, {}).pipe(map((response) => response.data));
  }

  listSnapshotRestoreJobs(): Observable<SnapshotRestoreJobRecord[]> {
    return this.http.get<ApiResponse<SnapshotRestoreJobRecord[]>>(`${this.apiUrl}/snapshots/restore-jobs`).pipe(map((response) => response.data));
  }

  deleteSnapshot(id: string): Observable<{ deleted: true }> {
    return this.http.delete<ApiResponse<{ deleted: true }>>(`${this.apiUrl}/snapshots/${id}`).pipe(map((response) => response.data));
  }

  listBackupPolicies(): Observable<BackupPolicyRecord[]> {
    return this.http.get<ApiResponse<BackupPolicyRecord[]>>(`${this.apiUrl}/backup-policies`).pipe(map((response) => response.data));
  }

  createBackupPolicy(policy: { name: string; destinationAccountId: string; schedule: BackupPolicyRecord['schedule']; retentionDays: number }): Observable<BackupPolicyRecord> {
    return this.http.post<ApiResponse<BackupPolicyRecord>>(`${this.apiUrl}/backup-policies`, policy).pipe(map((response) => response.data));
  }

  updateBackupPolicy(id: string, policy: Partial<Pick<BackupPolicyRecord, 'enabled' | 'name' | 'schedule' | 'retentionDays' | 'destinationAccountId'>>): Observable<BackupPolicyRecord> {
    return this.http.patch<ApiResponse<BackupPolicyRecord>>(`${this.apiUrl}/backup-policies/${id}`, policy).pipe(map((response) => response.data));
  }

  deleteBackupPolicy(id: string): Observable<{ deleted: true }> {
    return this.http.delete<ApiResponse<{ deleted: true }>>(`${this.apiUrl}/backup-policies/${id}`).pipe(map((response) => response.data));
  }

  runBackupPolicy(id: string): Observable<BackupJobRecord> {
    return this.http.post<ApiResponse<BackupJobRecord>>(`${this.apiUrl}/backup-policies/${id}/run`, {}).pipe(map((response) => response.data));
  }

  listBackups(): Observable<BackupJobRecord[]> {
    return this.http.get<ApiResponse<BackupJobRecord[]>>(`${this.apiUrl}/backups`).pipe(map((response) => response.data));
  }

  restoreBackup(id: string): Observable<SnapshotRestoreJobRecord> {
    return this.http.post<ApiResponse<SnapshotRestoreJobRecord>>(`${this.apiUrl}/backups/${id}/restore`, {}).pipe(map((response) => response.data));
  }

  getProtectionOverview(): Observable<ProtectionOverviewRecord> {
    return this.http.get<ApiResponse<ProtectionOverviewRecord>>(`${this.apiUrl}/protection/overview`).pipe(map((response) => response.data));
  }

  streamProtectionEvents(): Observable<DataProtectionEventRecord> {
    return new Observable<DataProtectionEventRecord>((subscriber) => {
      const controller = new AbortController();
      const token = this.auth.accessToken;
      void fetch(`${this.apiUrl}/protection/events`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok || !response.body) throw new Error('Protection event stream unavailable');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const messages = buffer.split('\n\n');
          buffer = messages.pop() ?? '';
          for (const message of messages) {
            const data = message.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim();
            if (data) subscriber.next(JSON.parse(data) as DataProtectionEventRecord);
          }
        }
        subscriber.complete();
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) subscriber.error(error);
      });
      return () => controller.abort();
    });
  }

  listProtectionAlerts(): Observable<ProtectionAlertRecord[]> {
    return this.http.get<ApiResponse<ProtectionAlertRecord[]>>(`${this.apiUrl}/protection/alerts`).pipe(map((response) => response.data));
  }

  resolveProtectionAlert(id: string): Observable<ProtectionAlertRecord> {
    return this.http.patch<ApiResponse<ProtectionAlertRecord>>(`${this.apiUrl}/protection/alerts/${id}/resolve`, {}).pipe(map((response) => response.data));
  }

  rebalanceVirtual(): Observable<{ queued: number; skipped: number }> {
    return this.http.post<ApiResponse<{ queued: number; skipped: number }>>(`${this.apiUrl}/virtual-drive/rebalance`, {}).pipe(map((response) => response.data));
  }
}
