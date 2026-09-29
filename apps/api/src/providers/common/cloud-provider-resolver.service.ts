import { Injectable } from '@nestjs/common';
import { CloudProvider } from './cloud-provider.enum';
import { CloudProviderAdapter } from './cloud-provider.interface';
import { ProviderRegistryService } from './provider-registry.service';

@Injectable()
export class CloudProviderResolver {
  constructor(private readonly registry: ProviderRegistryService) {}

  resolve(provider: CloudProvider): CloudProviderAdapter {
    return this.registry.resolve(provider);
  }
}
