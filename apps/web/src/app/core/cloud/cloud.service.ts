import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, map } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api-response.model';
import { BackupJobRecord, BackupPolicyRecord, CloudAccount, CloudAccountImpactRecord, CloudFile, CloudProvider, CloudSearchResponse, CloudStorageSummary, DataProtectionEventRecord, FileVersionRecord, ProtectionAlertRecord, ProtectionOverviewRecord, ResourceShareRecord, ResourceShareRole, SharePage, ShareUserSearchResult, SnapshotEntryRecord, SnapshotRecord, SnapshotRestoreJobRecord, StorageRule, TransferJob, TransferProgressEvent, TransferOperation, VirtualNode } from '../../shared/models/cloud.model';

@Injectable({ providedIn: 'root' })
export class CloudService {
  private readonly apiUrl = environment.apiUrl;

  constructor(private readonly http: HttpClient, private readonly auth: AuthService) {}

  getAccounts(): Observable<CloudAccount[]> {
    return this.http.get<ApiResponse<CloudAccount[]>>(`${this.apiUrl}/cloud-accounts`).pipe(map((response) => response.data));
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
    const providerPath = provider === 'GOOGLE_DRIVE' ? 'google' : 'onedrive';
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
