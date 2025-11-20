import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from "class-validator";
import { Type } from "class-transformer";

export class BulkReviewLeaveIdsDto {
  @ApiPropertyOptional({
    description: "Calendar month (1-12) to select requests when IDs are not supplied.",
    minimum: 1,
    maximum: 12,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @ApiPropertyOptional({
    description: "Calendar year paired with the month filter.",
  })
  @IsOptional()
  @ValidateIf((payload) => payload.month !== undefined)
  @IsInt()
  year?: number;

  @ApiPropertyOptional({
    type: [Number],
    description: "Explicit leave request IDs to review; overrides month/year when present.",
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  requestIds?: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comment?: string;
}
