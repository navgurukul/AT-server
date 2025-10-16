import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class TimesheetEntryInput {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  id?: number;

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

export class UpsertTimesheetEntriesDto {
  @ApiProperty({ type: [TimesheetEntryInput] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TimesheetEntryInput)
  entries!: TimesheetEntryInput[];
}
