import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';

export class UpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  managerId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  employeeDepartmentId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  workLocationType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateOfJoining?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  employmentType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  employmentStatus?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateOfExit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  slackId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  alumniStatus?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  gender?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  discordId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];
}
