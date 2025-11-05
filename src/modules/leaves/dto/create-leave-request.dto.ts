import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateLeaveRequestDto {
  @ApiProperty()
  @IsInt()
  leaveTypeId!: number;

  @ApiProperty()
  @IsDateString()
  startDate!: string;

  @ApiProperty()
  @IsDateString()
  endDate!: string;

  @ApiPropertyOptional({
    description:
      'Total working hours requested in the range. If omitted, full working days in the range are used.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  hours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({
    enum: ['half_day', 'full_day', 'custom'],
    description:
      'Half/Full day helper. Use custom when providing explicit hours.',
  })
  @IsOptional()
  @IsIn(['half_day', 'full_day', 'custom'])
  durationType?: 'half_day' | 'full_day' | 'custom';

  @ApiPropertyOptional({
    enum: ['first_half', 'second_half'],
    description: 'Required when requesting a half-day leave.',
  })
  @IsOptional()
  @IsIn(['first_half', 'second_half'])
  halfDaySegment?: 'first_half' | 'second_half';
}
