import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsDateString, IsEnum, IsInt, IsOptional, IsString } from "class-validator";

export class GrantCompOffDto {
  @ApiProperty()
  @IsInt()
  userId!: number;

  @ApiProperty()
  @IsDateString()
  workDate!: string;

  @ApiProperty({ enum: ["half_day", "full_day"] })
  @IsEnum(["half_day", "full_day"])
  duration!: "half_day" | "full_day";

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
