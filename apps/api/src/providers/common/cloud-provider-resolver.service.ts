import { Injectable } from '@nestjs/common';
import { CloudProvider } from './cloud-provider.enum';
import { CloudProviderAdapter } from './cloud-provider.interface';
import { GoogleDriveAdapter } from '../google-drive/google-drive.adapter';
import { OneDriveAdapter } from '../onedrive/onedrive.adapter';

@Injectable()
export class CloudProviderResolver {
  constructor(
    private readonly googleDrive: GoogleDriveAdapter,
    private readonly oneDrive: OneDriveAdapter,
  ) {}

  resolve(provider: CloudProvider): CloudProviderAdapter {
    if (provider === CloudProvider.GOOGLE_DRIVE) return this.googleDrive;
    if (provider === CloudProvider.ONEDRIVE) return this.oneDrive;
    throw new Error(`Unsupported cloud provider: ${provider}`);
  }
}
