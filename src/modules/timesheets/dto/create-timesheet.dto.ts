import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

class CreateTimesheetEntryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  projectId?: number;

  @ApiProperty()
  @IsString()
  taskTitle!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  taskDescription?: string;

  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  hours!: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class CreateTimesheetDto {
  @ApiProperty()
  @IsDateString()
  workDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ type: [CreateTimesheetEntryDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTimesheetEntryDto)
  entries!: CreateTimesheetEntryDto[];
}
