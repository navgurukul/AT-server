import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class SubmitTimesheetDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}
