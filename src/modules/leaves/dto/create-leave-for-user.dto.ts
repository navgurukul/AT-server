import { ApiProperty } from '@nestjs/swagger';
import { IsInt } from 'class-validator';
import { CreateLeaveRequestDto } from './create-leave-request.dto';

export class CreateLeaveForUserDto extends CreateLeaveRequestDto {
  @ApiProperty({
    description: 'ID of the user for whom the leave is being applied',
  })
  @IsInt()
  userId!: number;
}
