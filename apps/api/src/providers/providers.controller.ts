import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProviderRegistryService } from './common/provider-registry.service';

@ApiTags('Providers')
@Controller('providers')
export class ProvidersController {
  constructor(private readonly registry: ProviderRegistryService) {}

  @Get()
  @ApiOperation({ summary: 'List supported cloud providers and their declared capabilities' })
  catalog() {
    return this.registry.getCatalog();
  }
}
