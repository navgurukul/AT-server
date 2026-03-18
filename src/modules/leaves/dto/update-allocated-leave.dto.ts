import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsNumber, Max, Min } from "class-validator";

export class UpdateAllocatedLeaveDto {
  @ApiProperty({
    description: "Target user whose leave balance allocation should be edited",
  })
  @IsInt()
  userId!: number;

  @ApiProperty({
    description: "Leave type for which allocation should be edited",
  })
  @IsInt()
  leaveTypeId!: number;

  @ApiProperty({
    description: "New allocated leave hours for the selected leave type",
    example: 120,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999.99)
  allocatedHours!: number;
}
