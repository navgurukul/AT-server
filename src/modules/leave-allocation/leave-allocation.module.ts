import { Module } from '@nestjs/common';
import { LeaveAllocationService } from './leave-allocation.service';
import { LeaveAllocationController } from './leave-allocation.controller';

@Module({
  controllers: [LeaveAllocationController],
  providers: [LeaveAllocationService],
  exports: [LeaveAllocationService],
})
export class LeaveAllocationModule {}
