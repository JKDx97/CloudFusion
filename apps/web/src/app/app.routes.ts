import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },
  { path: 'login', loadComponent: () => import('./features/auth/login/login.component').then((m) => m.LoginComponent) },
  { path: 'register', loadComponent: () => import('./features/auth/register/register.component').then((m) => m.RegisterComponent) },
  { path: 'dashboard', canActivate: [authGuard], loadComponent: () => import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent) },
  { path: 'transfers', canActivate: [authGuard], loadComponent: () => import('./features/transfers/transfer-center.component').then((m) => m.TransferCenterComponent) },
  { path: 'search', canActivate: [authGuard], loadComponent: () => import('./features/search/search.component').then((m) => m.SearchComponent) },
  { path: 'rules', canActivate: [authGuard], loadComponent: () => import('./features/rules/rules.component').then((m) => m.RulesComponent) },
  { path: '**', redirectTo: 'login' },
];
