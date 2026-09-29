import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'drive' },
  { path: 'login', loadComponent: () => import('./features/auth/login/login.component').then((m) => m.LoginComponent) },
  { path: 's/:token', loadComponent: () => import('./features/sharing/public-share.component').then((m) => m.PublicShareComponent) },
  { path: 'register', loadComponent: () => import('./features/auth/register/register.component').then((m) => m.RegisterComponent) },
  { path: 'dashboard', canActivate: [authGuard], loadComponent: () => import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent) },
  { path: 'drive', canActivate: [authGuard], loadComponent: () => import('./features/drive/drive.component').then((m) => m.DriveComponent) },
  { path: 'workspaces', canActivate: [authGuard], loadComponent: () => import('./features/workspaces/workspace-drive.component').then((m) => m.WorkspaceDriveComponent) },
  { path: 'protection', canActivate: [authGuard], loadComponent: () => import('./features/protection/protection.component').then((m) => m.ProtectionComponent) },
  { path: 'transfers', canActivate: [authGuard], loadComponent: () => import('./features/transfers/transfer-center.component').then((m) => m.TransferCenterComponent) },
  { path: 'search', canActivate: [authGuard], loadComponent: () => import('./features/search/search.component').then((m) => m.SearchComponent) },
  { path: 'rules', canActivate: [authGuard], loadComponent: () => import('./features/rules/rules.component').then((m) => m.RulesComponent) },
  { path: 'settings/api-access', canActivate: [authGuard], loadComponent: () => import('./features/settings/api-tokens.component').then((m) => m.ApiTokensComponent) },
  { path: 'settings/device-sync', canActivate: [authGuard], loadComponent: () => import('./features/settings/desktop-sync.component').then((m) => m.DesktopSyncComponent) },
  { path: 'providers', canActivate: [authGuard], loadComponent: () => import('./features/providers/providers.component').then((m) => m.ProvidersComponent) },
  { path: '**', redirectTo: 'login' },
];
