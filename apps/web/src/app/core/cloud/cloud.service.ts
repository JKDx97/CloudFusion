import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api-response.model';
import { CloudAccount, CloudFile, CloudProvider, CloudStorageSummary } from '../../shared/models/cloud.model';

@Injectable({ providedIn: 'root' })
export class CloudService {
  private readonly apiUrl = environment.apiUrl;

  constructor(private readonly http: HttpClient) {}

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
}
