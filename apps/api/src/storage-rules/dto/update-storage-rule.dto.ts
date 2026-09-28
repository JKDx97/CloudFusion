import { PartialType } from '@nestjs/swagger';
import { CreateStorageRuleDto } from './create-storage-rule.dto';

export class UpdateStorageRuleDto extends PartialType(CreateStorageRuleDto) {}
