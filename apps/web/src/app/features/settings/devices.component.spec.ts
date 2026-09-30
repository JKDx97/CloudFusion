import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../core/auth/auth.service';
import { DevicesComponent } from './devices.component';

describe('DevicesComponent', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<DevicesComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [DevicesComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: { deviceId: null } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(DevicesComponent);
  });

  afterEach(() => {
    fixture.destroy();
    http.verify();
  });

  it('requests a one-time code and displays it only in the current page', async () => {
    fixture.detectChanges();
    http.expectOne('http://localhost:3000/devices').flush({ data: [], message: 'ok' });
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
    const generateButton = Array.from(buttons)
      .find((button) => button.textContent?.includes('Generar código'));
    if (!generateButton) throw new Error('Pairing-code action was not rendered');
    generateButton.click();
    fixture.detectChanges();

    const pairingRequest = http.expectOne('http://localhost:3000/auth/device-pairing-codes');
    expect(pairingRequest.request.method).toBe('POST');
    pairingRequest.flush({
      data: { code: 'A1B2C3D4-E5F60718-192A3B4C-5D6E7F80', expiresAt: new Date(Date.now() + 300_000).toISOString() },
      message: 'ok',
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('A1B2C3D4-E5F60718-192A3B4C-5D6E7F80');
  });
});
