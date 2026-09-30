import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { AdvertiseAvailabilityDto } from './advertise-availability.dto';

export class AdvertiseAvailabilityBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AdvertiseAvailabilityDto)
  items!: AdvertiseAvailabilityDto[];
}
