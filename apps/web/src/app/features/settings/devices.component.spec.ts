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

  it('updates a device P2P opt-in through its authenticated settings endpoint', async () => {
    fixture.detectChanges();
    const device = {
      id: 'nas-device',
      name: 'CloudFusion NAS',
      platform: 'NAS',
      clientVersion: '0.1.0',
      p2pEnabled: false,
      lanDiscoveryEnabled: true,
      internetP2pEnabled: false,
      relayAllowed: true,
      serveLocalFiles: false,
      storageContributionEnabled: false,
      lastSeenAt: null,
      revokedAt: null,
    };
    http.expectOne('http://localhost:3000/devices').flush({ data: [device], message: 'ok' });
    await Promise.resolve();
    http.expectOne('http://localhost:3000/devices/nas-device/storage').flush({
      data: {
        deviceId: 'nas-device', enabled: false, maxBytes: null, usedBytes: '0', availableBytes: '0',
        storageClass: null, availabilityStatus: 'DISABLED', lastSeenAt: null,
      },
      message: 'ok',
    });
    await fixture.whenStable();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    fixture.detectChanges();

    const enableP2p = fixture.nativeElement.querySelector('[aria-label="Activar P2P en CloudFusion NAS"]') as HTMLButtonElement | null;
    if (!enableP2p) throw new Error('P2P opt-in control was not rendered');
    enableP2p.click();
    fixture.detectChanges();

    const update = http.expectOne('http://localhost:3000/devices/nas-device/settings');
    expect(update.request.method).toBe('PATCH');
    expect(update.request.body).toEqual({ p2pEnabled: true });
    update.flush({ data: { ...device, p2pEnabled: true }, message: 'ok' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[aria-label="Desactivar P2P en CloudFusion NAS"]')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('P2P: activado');
  });

  it('converts GiB to exact bytes when enabling a device storage target', async () => {
    fixture.detectChanges();
    const device = {
      id: 'nas-device',
      name: 'CloudFusion NAS',
      platform: 'NAS',
      clientVersion: '0.1.0',
      p2pEnabled: false,
      lanDiscoveryEnabled: true,
      internetP2pEnabled: false,
      relayAllowed: true,
      serveLocalFiles: false,
      storageContributionEnabled: false,
      lastSeenAt: null,
      revokedAt: null,
    };
    http.expectOne('http://localhost:3000/devices').flush({ data: [device], message: 'ok' });
    await Promise.resolve();
    http.expectOne('http://localhost:3000/devices/nas-device/storage').flush({
      data: {
        deviceId: 'nas-device', enabled: false, maxBytes: null, usedBytes: '0', availableBytes: '0',
        storageClass: null, availabilityStatus: 'DISABLED', lastSeenAt: null,
      },
      message: 'ok',
    });
    await fixture.whenStable();

    fixture.componentInstance.setStorageCapacity('nas-device', '1.5');
    const saving = fixture.componentInstance.saveStorageSettings(device, true);
    const update = http.expectOne('http://localhost:3000/devices/nas-device/storage');
    expect(update.request.method).toBe('PATCH');
    expect(update.request.body).toEqual({
      enabled: true,
      maxBytes: '1610612736',
      storageClass: 'DEVICE_VOLATILE',
    });
    update.flush({
      data: {
        deviceId: 'nas-device', enabled: true, maxBytes: '1610612736', usedBytes: '0',
        availableBytes: '1610612736', storageClass: 'DEVICE_VOLATILE',
        availabilityStatus: 'OFFLINE', lastSeenAt: null,
      },
      message: 'ok',
    });
    await Promise.resolve();
    http.expectOne('http://localhost:3000/devices').flush({
      data: [{ ...device, storageContributionEnabled: true }],
      message: 'ok',
    });
    await Promise.resolve();
    http.expectOne('http://localhost:3000/devices/nas-device/storage').flush({
      data: {
        deviceId: 'nas-device', enabled: true, maxBytes: '1610612736', usedBytes: '0',
        availableBytes: '1610612736', storageClass: 'DEVICE_VOLATILE',
        availabilityStatus: 'OFFLINE', lastSeenAt: null,
      },
      message: 'ok',
    });
    await saving;

    fixture.componentInstance.setStorageCapacity('nas-device', '');
    const disabling = fixture.componentInstance.saveStorageSettings(device, false);
    const disableRequest = http.expectOne('http://localhost:3000/devices/nas-device/storage');
    expect(disableRequest.request.body).toEqual({
      enabled: false,
      maxBytes: '1610612736',
      storageClass: 'DEVICE_VOLATILE',
    });
    disableRequest.flush({
      data: {
        deviceId: 'nas-device', enabled: false, maxBytes: '1610612736', usedBytes: '0',
        availableBytes: '1610612736', storageClass: 'DEVICE_VOLATILE',
        availabilityStatus: 'DISABLED', lastSeenAt: null,
      },
      message: 'ok',
    });
    await Promise.resolve();
    http.expectOne('http://localhost:3000/devices').flush({
      data: [{ ...device, storageContributionEnabled: false }],
      message: 'ok',
    });
    await Promise.resolve();
    http.expectOne('http://localhost:3000/devices/nas-device/storage').flush({
      data: {
        deviceId: 'nas-device', enabled: false, maxBytes: '1610612736', usedBytes: '0',
        availableBytes: '1610612736', storageClass: 'DEVICE_VOLATILE',
        availabilityStatus: 'DISABLED', lastSeenAt: null,
      },
      message: 'ok',
    });
    await disabling;
  });
});
