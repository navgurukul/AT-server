import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty } from 'class-validator';

export class UpdateUserRoleDto {
  @ApiProperty({
    description: 'The role to assign to the user',
    enum: ['super_admin', 'admin', 'employee'],
    example: 'employee',
  })
  @IsNotEmpty()
  @IsEnum(['super_admin', 'admin', 'employee'])
  role!: 'super_admin' | 'admin' | 'employee';
}
