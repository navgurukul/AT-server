import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateHolidayDto {
  @ApiPropertyOptional({ description: 'Holiday display name' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ description: 'Mark as working day instead of holiday' })
  @IsOptional()
  @IsBoolean()
  isWorkingDay?: boolean;
}
