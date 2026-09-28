import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, of, throwError } from 'rxjs';
import { catchError, map, shareReplay, switchMap, tap } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api-response.model';
import { User } from '../../shared/models/user.model';

interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

interface Credentials {
  email: string;
  password: string;
}

interface RegistrationData extends Credentials {
  username: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly apiUrl = environment.apiUrl;
  private readonly accessTokenKey = 'cloudfusion.accessToken';
  private readonly refreshTokenKey = 'cloudfusion.refreshToken';
  private readonly userKey = 'cloudfusion.user';
  private readonly userSubject = new BehaviorSubject<User | null>(this.readUser());
  private refreshRequest$?: Observable<string>;

  readonly currentUser$ = this.userSubject.asObservable();

  constructor(private readonly http: HttpClient) {}

  get accessToken(): string | null {
    return localStorage.getItem(this.accessTokenKey);
  }

  get refreshToken(): string | null {
    return localStorage.getItem(this.refreshTokenKey);
  }

  login(credentials: Credentials): Observable<User> {
    return this.http.post<ApiResponse<AuthResponse>>(this.apiUrl + '/auth/login', credentials).pipe(
      map((response) => response.data),
      tap((session) => this.saveSession(session)),
      map((session) => session.user),
    );
  }

  register(data: RegistrationData): Observable<User> {
    return this.http.post<ApiResponse<AuthResponse>>(this.apiUrl + '/auth/register', data).pipe(
      map((response) => response.data),
      tap((session) => this.saveSession(session)),
      map((session) => session.user),
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

    this.refreshRequest$ = this.http
      .post<ApiResponse<AuthResponse>>(this.apiUrl + '/auth/refresh', { refreshToken: token })
      .pipe(
        map((response) => response.data),
        tap((session) => this.saveSession(session)),
        map((session) => session.accessToken),
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
    localStorage.removeItem(this.accessTokenKey);
    localStorage.removeItem(this.refreshTokenKey);
    localStorage.removeItem(this.userKey);
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

  private saveSession(session: AuthResponse): void {
    localStorage.setItem(this.accessTokenKey, session.accessToken);
    localStorage.setItem(this.refreshTokenKey, session.refreshToken);
    this.saveUser(session.user);
  }

  private saveUser(user: User): void {
    localStorage.setItem(this.userKey, JSON.stringify(user));
    this.userSubject.next(user);
  }

  private readUser(): User | null {
    try {
      const user = localStorage.getItem(this.userKey);
      return user ? (JSON.parse(user) as User) : null;
    } catch {
      return null;
    }
  }
}
