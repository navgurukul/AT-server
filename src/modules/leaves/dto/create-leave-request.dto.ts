import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

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
    description:
      'Course or programme name (required for Exam Leave and L&D Leave).',
  })
  @IsOptional()
  @IsString()
  courseOrProgrammeName?: string;

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
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsIn(['first_half', 'second_half'])
  halfDaySegment?: 'first_half' | 'second_half';

  @ApiPropertyOptional({
    enum: ['parent', 'child', 'other_immediate_family_member'],
    description:
      'Required for bereavement leave. Select the relationship to the deceased.',
  })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsIn(['parent', 'child', 'other_immediate_family_member'])
  relationship?:
    | 'parent'
    | 'child'
    | 'other_immediate_family_member';

  @ApiPropertyOptional({
    description:
      'Required when relationship is Other immediate family member.',
  })
  @ValidateIf(
    (payload) => payload.relationship === 'other_immediate_family_member',
  )
  @IsString()
  @IsNotEmpty()
  relationshipDetails?: string;

  @ApiPropertyOptional({ type: 'string', format: 'binary' })
  @IsOptional()
  document?: any;
}
