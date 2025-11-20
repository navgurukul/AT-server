import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class UpdateBackfillLimitDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  userId!: number;

  @ApiProperty({ description: 'Year in UTC, e.g., 2025' })
  @IsInt()
  year!: number;

  @ApiProperty({ description: 'Month 1-12 in UTC' })
  @IsInt()
  @Min(1)
  month!: number;

  @ApiProperty({ description: 'Allowed backfill count for the month' })
  @IsInt()
  @Min(0)
  limit!: number;
}
