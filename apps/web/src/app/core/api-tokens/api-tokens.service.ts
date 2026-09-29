import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api-response.model';

export const API_TOKEN_SCOPES = [
  { value: 'files:read', label: 'Leer archivos', description: 'Listar y descargar archivos.' },
  { value: 'files:write', label: 'Crear y editar archivos', description: 'Subir, crear y renombrar elementos.' },
  { value: 'files:delete', label: 'Eliminar archivos', description: 'Eliminar elementos.' },
  { value: 'webdav', label: 'WebDAV', description: 'Conectar clientes compatibles con WebDAV.' },
  { value: 's3', label: 'S3 compatible', description: 'Conectar aplicaciones compatibles con S3.' },
  { value: 'sync', label: 'Sincronización', description: 'Usar funciones de sincronización.' },
  { value: 'desktop', label: 'Aplicación de escritorio', description: 'Autorizar el cliente CloudFusion Desktop.' },
] as const;

export type ApiTokenScope = typeof API_TOKEN_SCOPES[number]['value'];

export interface ApiTokenRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiTokenScope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreatedApiToken extends ApiTokenRecord {
  token: string;
}

@Injectable({ providedIn: 'root' })
export class ApiTokensService {
  private readonly apiUrl = environment.apiUrl;

  constructor(private readonly http: HttpClient) {}

  list(): Observable<ApiTokenRecord[]> {
    return this.http.get<ApiResponse<ApiTokenRecord[]>>(`${this.apiUrl}/api-tokens`).pipe(map((response) => response.data));
  }

  create(input: { name: string; scopes: ApiTokenScope[]; expiresAt?: string }): Observable<CreatedApiToken> {
    return this.http.post<ApiResponse<CreatedApiToken>>(`${this.apiUrl}/api-tokens`, input).pipe(map((response) => response.data));
  }

  revoke(id: string): Observable<ApiTokenRecord> {
    return this.http.delete<ApiResponse<ApiTokenRecord>>(`${this.apiUrl}/api-tokens/${id}`).pipe(map((response) => response.data));
  }
}
