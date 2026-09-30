import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, from, of, throwError } from 'rxjs';
import { catchError, map, shareReplay, switchMap, tap } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api-response.model';
import { User } from '../../shared/models/user.model';

interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
  deviceId?: string;
}

interface Credentials {
  email: string;
  password: string;
}

interface RegistrationData extends Credentials {
  username: string;
}

interface DesktopDeviceRegistration {
  installationId: string;
  name: string;
  platform: 'WINDOWS' | 'MACOS' | 'LINUX' | 'NAS';
  clientVersion: string;
  peerId: string;
  peerPublicKey: string;
}

interface TauriWindow extends Window {
  __TAURI__?: {
    core?: {
      invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    };
  };
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly apiUrl = environment.apiUrl;
  private readonly accessTokenKey = 'cloudfusion.accessToken';
  private readonly refreshTokenKey = 'cloudfusion.refreshToken';
  private readonly desktopRefreshTokenMarker = 'cloudfusion.desktop.hasSecureRefreshToken';
  private readonly deviceIdKey = 'cloudfusion.deviceId';
  private readonly userKey = 'cloudfusion.user';
  private readonly userSubject = new BehaviorSubject<User | null>(this.readUser());
  private refreshRequest$?: Observable<string>;

  readonly currentUser$ = this.userSubject.asObservable();

  constructor(private readonly http: HttpClient) {}

  get accessToken(): string | null {
    return this.isDesktop()
      ? sessionStorage.getItem(this.accessTokenKey)
      : localStorage.getItem(this.accessTokenKey);
  }

  get refreshToken(): string | null {
    return this.isDesktop()
      ? localStorage.getItem(this.desktopRefreshTokenMarker)
      : localStorage.getItem(this.refreshTokenKey);
  }

  get deviceId(): string | null {
    return localStorage.getItem(this.deviceIdKey);
  }

  login(credentials: Credentials): Observable<User> {
    return this.deviceRegistration().pipe(
      switchMap((device) => this.http.post<ApiResponse<AuthResponse>>(
        this.apiUrl + '/auth/login',
        device ? { ...credentials, device } : credentials,
      )),
      map((response) => response.data),
      switchMap((session) => from(this.saveSession(session)).pipe(map(() => session.user))),
    );
  }

  register(data: RegistrationData): Observable<User> {
    return this.deviceRegistration().pipe(
      switchMap((device) => this.http.post<ApiResponse<AuthResponse>>(
        this.apiUrl + '/auth/register',
        device ? { ...data, device } : data,
      )),
      map((response) => response.data),
      switchMap((session) => from(this.saveSession(session)).pipe(map(() => session.user))),
    );
  }

  getMe(): Observable<User> {
    return this.http.get<ApiResponse<User>>(this.apiUrl + '/auth/me').pipe(
      map((response) => response.data),
      tap((user) => this.saveUser(user)),
    );
  }

  ensureSession(): Observable<User | null> {
    if (this.accessToken) return this.getMe().pipe(catchError(() => this.refreshAndLoadUser()));
    return this.refreshToken ? this.refreshAndLoadUser() : of(null);
  }

  refreshAccessToken(): Observable<string> {
    if (this.refreshRequest$) return this.refreshRequest$;
    const token = this.refreshToken;
    if (!token) return throwError(() => new Error('No refresh token available'));

    this.refreshRequest$ = this.storedRefreshToken()
      .pipe(
        switchMap((refreshToken) => refreshToken
          ? this.http.post<ApiResponse<AuthResponse>>(this.apiUrl + '/auth/refresh', { refreshToken })
          : throwError(() => new Error('No refresh token available'))),
        map((response) => response.data),
        switchMap((session) => from(this.saveSession(session)).pipe(map(() => session.accessToken))),
        shareReplay({ bufferSize: 1, refCount: false }),
        catchError((error) => {
          this.clearSession();
          return throwError(() => error);
        }),
      );

    return this.refreshRequest$.pipe(
      tap({
        complete: () => (this.refreshRequest$ = undefined),
        error: () => (this.refreshRequest$ = undefined),
      }),
    );
  }

  logout(): Observable<void> {
    if (!this.accessToken) {
      this.clearSession();
      return of(void 0);
    }
    return this.http.post<ApiResponse<{ loggedOut: true }>>(this.apiUrl + '/auth/logout', {}).pipe(
      map(() => void 0),
      catchError(() => of(void 0)),
      tap(() => this.clearSession()),
    );
  }

  clearSession(): void {
    if (this.isDesktop()) {
      sessionStorage.removeItem(this.accessTokenKey);
      localStorage.removeItem(this.desktopRefreshTokenMarker);
      void this.nativeInvoke<void>('stop_lan_mesh').catch(() => undefined);
      void this.nativeInvoke<void>('delete_refresh_token').catch(() => undefined);
    } else {
      localStorage.removeItem(this.accessTokenKey);
      localStorage.removeItem(this.refreshTokenKey);
    }
    localStorage.removeItem(this.userKey);
    localStorage.removeItem(this.deviceIdKey);
    this.userSubject.next(null);
  }

  private refreshAndLoadUser(): Observable<User | null> {
    return this.refreshAccessToken().pipe(
      switchMap(() => this.getMe()),
      catchError(() => {
        this.clearSession();
        return of(null);
      }),
    );
  }

  private saveSession(session: AuthResponse): Promise<void> {
    if (this.isDesktop()) {
      return this.nativeInvoke<void>('store_refresh_token', { refreshToken: session.refreshToken }).then(() => {
        sessionStorage.setItem(this.accessTokenKey, session.accessToken);
        localStorage.setItem(this.desktopRefreshTokenMarker, '1');
        this.saveDeviceId(session.deviceId);
        this.saveUser(session.user);
        return this.nativeInvoke<void>('configure_mesh_api', {
          apiUrl: this.apiUrl,
          accessToken: session.accessToken,
        }).catch(() => undefined);
      });
    }

    localStorage.setItem(this.accessTokenKey, session.accessToken);
    localStorage.setItem(this.refreshTokenKey, session.refreshToken);
    this.saveDeviceId(session.deviceId);
    this.saveUser(session.user);
    return Promise.resolve();
  }

  private saveUser(user: User): void {
    localStorage.setItem(this.userKey, JSON.stringify(user));
    this.userSubject.next(user);
  }

  private saveDeviceId(deviceId?: string): void {
    if (deviceId) localStorage.setItem(this.deviceIdKey, deviceId);
    else localStorage.removeItem(this.deviceIdKey);
  }

  private readUser(): User | null {
    try {
      const user = localStorage.getItem(this.userKey);
      return user ? (JSON.parse(user) as User) : null;
    } catch {
      return null;
    }
  }

  private isDesktop(): boolean {
    return typeof window !== 'undefined' && !!(window as TauriWindow).__TAURI__?.core?.invoke;
  }

  private deviceRegistration(): Observable<DesktopDeviceRegistration | undefined> {
    return this.isDesktop()
      ? from(this.nativeInvoke<DesktopDeviceRegistration>('get_device_registration'))
      : of(undefined);
  }

  private storedRefreshToken(): Observable<string | null> {
    return this.isDesktop()
      ? from(this.nativeInvoke<string | null>('get_refresh_token'))
      : of(this.refreshToken);
  }

  private nativeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const invoke = (window as TauriWindow).__TAURI__?.core?.invoke;
    if (!invoke) return Promise.reject(new Error('CloudFusion Desktop bridge is unavailable'));
    return invoke<T>(command, args);
  }
}
