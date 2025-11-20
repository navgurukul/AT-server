import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class BulkReviewLeaveRequestsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  userId?: number;

  @ApiPropertyOptional({
    description:
      'Calendar month (1-12) used to select leave requests when explicit IDs are not supplied.',
    minimum: 1,
    maximum: 12,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @ApiPropertyOptional({
    description: 'Calendar year that pairs with the month filter.',
  })
  @IsOptional()
  @ValidateIf((payload) => payload.month !== undefined)
  @IsInt()
  year?: number;

  @ApiPropertyOptional({
    type: [Number],
    description:
      'Explicit leave request identifiers to review; overrides month/year filtering when present.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  requestIds?: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comment?: string;
}

