import { Controller, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { LeaveAllocationService } from './leave-allocation.service';

@ApiTags('leave-allocation')
@Controller('leave-allocation')
export class LeaveAllocationController {
  constructor(private readonly leaveAllocationService: LeaveAllocationService) {}

  @Post('initialize/:userId')
  @Roles('admin', 'super_admin')
  @Permissions('leave:create:any')
  async initialize(@Param('userId', ParseIntPipe) userId: number) {
    return this.leaveAllocationService.initialize(userId);
  }
}
