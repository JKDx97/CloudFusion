import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, map } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api-response.model';
import { CloudAccount, CloudFile, CloudProvider, CloudSearchResponse, CloudStorageSummary, StorageRule, TransferJob, TransferProgressEvent, TransferOperation } from '../../shared/models/cloud.model';

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

  connect(provider: CloudProvider): void {
    window.location.assign(`${this.apiUrl}/cloud-accounts/${provider === 'GOOGLE_DRIVE' ? 'google' : 'onedrive'}/connect`);
  }

  refreshAccount(accountId: string): Observable<CloudAccount> {
    return this.http.post<ApiResponse<CloudAccount>>(`${this.apiUrl}/cloud-accounts/${accountId}/refresh`, {}).pipe(map((response) => response.data));
  }

  disconnect(accountId: string): Observable<{ disconnected: true }> {
    return this.http.delete<ApiResponse<{ disconnected: true }>>(`${this.apiUrl}/cloud-accounts/${accountId}`).pipe(map((response) => response.data));
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
}
