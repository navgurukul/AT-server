import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ReviewLeaveRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comment?: string;
}
