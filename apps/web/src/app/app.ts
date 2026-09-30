import { Component, Injector, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DesktopSyncBackgroundService } from './core/sync/desktop-sync-background.service';

@Component({
  imports: [RouterOutlet],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  constructor() {
    const injector = inject(Injector);
    if (typeof window !== 'undefined' && !!(window as Window & { __TAURI__?: unknown }).__TAURI__) {
      injector.get(DesktopSyncBackgroundService).start();
    }
  }
}
