import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateHolidayDto {
  @ApiProperty()
  @IsInt()
  orgId!: number;

  @ApiProperty({ description: 'Holiday date (YYYY-MM-DD)', example: '2025-12-25' })
  @IsDateString()
  date!: string;

  @ApiProperty({ description: 'Holiday name' })
  @IsString()
  @MaxLength(160)
  name!: string;

  @ApiProperty({ description: 'Mark as working day', required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isWorkingDay?: boolean;
}
