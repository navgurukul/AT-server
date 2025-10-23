import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { CreateLeaveRequestDto } from './dto/create-leave-request.dto';
import { ReviewLeaveRequestDto } from './dto/review-leave-request.dto';
import { BulkReviewLeaveRequestsDto } from './dto/bulk-review-leave-requests.dto';
import { LeavesService } from './leaves.service';

@ApiTags('leaves')
@Controller('leaves')
export class LeavesController {
  constructor(private readonly leavesService: LeavesService) {}

  @Get('balances')
  @Permissions('leave:view:self')
  getBalances(@CurrentUser() user: AuthenticatedUser | undefined) {
    if (!user) {
      return null;
    }
    return this.leavesService.listBalances(user.id);
  }

  @Get('requests')
  @ApiQuery({ name: 'state', required: false })
  @ApiQuery({ name: 'managerId', required: false })
  @Permissions('leave:view:team')
  listRequests(
    @Query('state') state?: string,
    @Query('managerId') managerId?: string,
  ) {
    const normalizedState =
      state && ['pending', 'approved', 'rejected', 'cancelled'].includes(state)
        ? (state as 'pending' | 'approved' | 'rejected' | 'cancelled')
        : undefined;

    return this.leavesService.listLeaveRequests({
      state: normalizedState,
      managerId: managerId ? Number.parseInt(managerId, 10) : undefined,
    });
  }

  @Post('requests')
  @Permissions('leave:create:self')
  requestLeave(
    @Body() payload: CreateLeaveRequestDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    if (!user) {
      return null;
    }
    return this.leavesService.createLeaveRequest(user.id, user.orgId, payload);
  }

  @Post('requests/:id/approve')
  @Permissions('leave:approve:team')
  approveRequest(
    @Param('id', ParseIntPipe) requestId: number,
    @Body() payload: ReviewLeaveRequestDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return this.leavesService.reviewLeaveRequest(
      requestId,
      'approve',
      payload,
      user?.id ?? 0,
    );
  }

  @Post('requests/:id/reject')
  @Permissions('leave:approve:team')
  rejectRequest(
    @Param('id', ParseIntPipe) requestId: number,
    @Body() payload: ReviewLeaveRequestDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return this.leavesService.reviewLeaveRequest(
      requestId,
      'reject',
      payload,
      user?.id ?? 0,
    );
  }

  @Post('requests/bulk/approve')
  @Permissions('leave:approve:team')
  bulkApprove(
    @Body() payload: BulkReviewLeaveRequestsDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return this.leavesService.bulkReviewLeaveRequests(
      payload,
      'approve',
      user?.id ?? 0,
    );
  }

  @Post('requests/bulk/reject')
  @Permissions('leave:approve:team')
  bulkReject(
    @Body() payload: BulkReviewLeaveRequestsDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return this.leavesService.bulkReviewLeaveRequests(
      payload,
      'reject',
      user?.id ?? 0,
    );
  }
}
