import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

class CreateTimesheetEntryAdminDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  projectId?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  taskTitle?: string;

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

export class CreateTimesheetAdminDto {
  @ApiProperty()
  @IsInt()
  userId!: number;

  @ApiProperty()
  @IsDateString()
  workDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ type: [CreateTimesheetEntryAdminDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTimesheetEntryAdminDto)
  entries!: CreateTimesheetEntryAdminDto[];
}
