import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Param,
  ParseIntPipe,
  Post,
  Query,
  ValidationPipe,
} from "@nestjs/common";
import { ApiQuery, ApiTags } from "@nestjs/swagger";

import { Permissions } from "../../common/decorators/permissions.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../../common/types/authenticated-user.interface";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";
import { CreateLeaveForUserDto } from "./dto/create-leave-for-user.dto";
import { ReviewLeaveRequestDto } from "./dto/review-leave-request.dto";
import { BulkReviewLeaveIdsDto } from "./dto/bulk-review-leave-ids.dto";
import { GrantCompOffDto } from "./dto/grant-comp-off.dto";
import { RevokeCompOffDto } from "./dto/revoke-comp-off.dto";
import { UpdateAllocatedLeaveDto } from "./dto/update-allocated-leave.dto";
import { LeavesService } from "./leaves.service";

@ApiTags("leaves")
@Controller("leaves")
export class LeavesController {
  constructor(private readonly leavesService: LeavesService) {}

  @Get("balances")
  @Permissions("leave:view:self")
  getBalances(@CurrentUser() user: AuthenticatedUser | undefined) {
    if (!user) {
      return null;
    }
    return this.leavesService.listBalances(user.id);
  }

  @Get("balances/employee")
  @Permissions("leave:view:team")
  getEmployeeBalancesByEmail(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query("email") email?: string
  ) {
    if (!user) {
      return null;
    }

    if (!email || !email.trim()) {
      throw new BadRequestException("email is required");
    }

    return this.leavesService.listBalancesForActorByEmail(user, email);
  }

  @Get("requests")
  @ApiQuery({ name: "state", required: false })
  @ApiQuery({ name: "managerId", required: false })
  @Permissions("leave:view:team")
  listRequests(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query("state") state?: string,
    @Query("managerId") managerId?: string
  ) {
    const normalizedState =
      state && ["pending", "approved", "rejected", "cancelled"].includes(state)
        ? (state as "pending" | "approved" | "rejected" | "cancelled")
        : undefined;

    return this.leavesService.listLeaveRequests({
      actor: user,
      state: normalizedState,
      managerId: managerId ? Number.parseInt(managerId, 10) : undefined,
      excludeUserId: user?.id,
    });
  }

  @Get("types")
  @Permissions("leave:view:self")
  listLeaveTypes(@CurrentUser() user: AuthenticatedUser | undefined) {
    if (!user) {
      return null;
    }
    return this.leavesService.listLeaveTypes(user.orgId);
  }

  @Post("requests")
  @Permissions("leave:create:self")
  requestLeave(
    @Body() payload: CreateLeaveRequestDto,
    @CurrentUser() user: AuthenticatedUser | undefined
  ) {
    if (!user) {
      return null;
    }
    return this.leavesService.createLeaveRequest(user.id, user.orgId, payload);
  }

  @Get("my-requests")
  @Permissions("leave:view:self")
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "to", required: false })
  listMyRequests(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query("from") from?: string,
    @Query("to") to?: string
  ) {
    if (!user) {
      return null;
    }
    return this.leavesService.listUserLeaveHistory(user.id, user.orgId, {
      from: from ?? undefined,
      to: to ?? undefined,
    });
  }

  @Get("comp-offs")
  @Permissions("leave:view:self")
  listCompOffCredits(
    @Query("userId") userId: string | undefined,
    @Query("status")
    status: "pending" | "granted" | "expired" | "revoked" | undefined,
    @CurrentUser() actor: AuthenticatedUser | undefined
  ) {
    if (!actor) {
      return null;
    }
    return this.leavesService.listCompOffCredits(actor, {
      userId: userId ? Number.parseInt(userId, 10) : undefined,
      status,
    });
  }

  @Post("comp-offs")
  @Permissions("leave:approve:team")
  grantCompOff(
    @Body() payload: GrantCompOffDto,
    @CurrentUser() actor: AuthenticatedUser | undefined
  ) {
    if (!actor) {
      return null;
    }
    return this.leavesService.grantCompOffCredit(actor, payload);
  }

  @Post("comp-offs/:id/revoke")
  @Permissions("leave:approve:team")
  revokeCompOff(
    @Param("id", ParseIntPipe) creditId: number,
    @Body() payload: RevokeCompOffDto,
    @CurrentUser() actor: AuthenticatedUser | undefined
  ) {
    if (!actor) {
      return null;
    }
    return this.leavesService.revokeCompOffCredit(actor, creditId, payload);
  }

  @Post("requests/:id/approve")
  @Permissions("leave:approve:team")
  approveRequest(
    @Param("id", ParseIntPipe) requestId: number,
    @Body() payload: ReviewLeaveRequestDto,
    @CurrentUser() user: AuthenticatedUser | undefined
  ) {
    return this.leavesService.reviewLeaveRequest(
      requestId,
      "approve",
      payload,
      user?.id ?? 0
    );
  }

  @Post("requests/:id/reject")
  @Permissions("leave:approve:team")
  rejectRequest(
    @Param("id", ParseIntPipe) requestId: number,
    @Body() payload: ReviewLeaveRequestDto,
    @CurrentUser() user: AuthenticatedUser | undefined
  ) {
    return this.leavesService.reviewLeaveRequest(
      requestId,
      "reject",
      payload,
      user?.id ?? 0
    );
  }

  // Alternate bulk approve using body payload (simpler for clients)
  @Post("requests/approve")
  @Permissions("leave:approve:team")
  bulkApproveBody(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }))
    payload: BulkReviewLeaveIdsDto,
    @CurrentUser() user: AuthenticatedUser | undefined
  ) {
    return this.leavesService.bulkReviewLeaveRequests(
      payload,
      "approve",
      user?.id ?? 0
    );
  }

  @Post("requests/reject")
  @Permissions("leave:approve:team")
  bulkRejectBody(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }))
    payload: BulkReviewLeaveIdsDto,
    @CurrentUser() user: AuthenticatedUser | undefined
  ) {
    return this.leavesService.bulkReviewLeaveRequests(
      payload,
      "reject",
      user?.id ?? 0
    );
  }

  // @Post("requests/bulk/approve")
  // @Permissions("leave:approve:team")
  // bulkApprove(
  //   @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }))
  //   payload: BulkReviewLeaveIdsDto,
  //   @CurrentUser() user: AuthenticatedUser | undefined
  // ) {
  //   return this.leavesService.bulkReviewLeaveRequests(
  //     payload,
  //     "approve",
  //     user?.id ?? 0
  //   );
  // }

  // @Post("requests/bulk/reject")
  // @Permissions("leave:approve:team")
  // bulkReject(
  //   @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }))
  //   payload: BulkReviewLeaveIdsDto,
  //   @CurrentUser() user: AuthenticatedUser | undefined
  // ) {
  //   return this.leavesService.bulkReviewLeaveRequests(
  //     payload,
  //     "reject",
  //     user?.id ?? 0
  //   );
  // }

  @Post("admin/apply")
  @Permissions("leave:create:any")
  applyLeaveForUser(
    @Body() payload: CreateLeaveForUserDto,
    @CurrentUser() actor: AuthenticatedUser | undefined
  ) {
    if (!actor) {
      return null;
    }
    return this.leavesService.createLeaveRequestForUser(actor, payload);
  }

  @Patch("admin/requests/:id")
  @Permissions("leave:create:any")
  @Roles("admin", "super_admin")
  editLeaveRequestForAnyEmployee(
    @Param("id", ParseIntPipe) requestId: number,
    @Body() payload: CreateLeaveRequestDto,
    @CurrentUser() actor: AuthenticatedUser | undefined
  ) {
    if (!actor) {
      return null;
    }
    return this.leavesService.adminEditLeaveRequest(actor, requestId, payload);
  }

  @Delete("admin/requests/:id")
  @Permissions("leave:create:any")
  @Roles("admin", "super_admin")
  deleteApprovedLeaveForAnyEmployee(
    @Param("id", ParseIntPipe) requestId: number,
    @CurrentUser() actor: AuthenticatedUser | undefined
  ) {
    if (!actor) {
      return null;
    }
    return this.leavesService.adminDeleteApprovedLeaveRequest(actor, requestId);
  }

  @Patch("admin/balances/allocated")
  @Permissions("leave:create:any")
  @Roles("admin", "super_admin")
  updateAllocatedLeaveForAnyEmployee(
    @Body() payload: UpdateAllocatedLeaveDto,
    @CurrentUser() actor: AuthenticatedUser | undefined
  ) {
    if (!actor) {
      return null;
    }

    return this.leavesService.adminUpdateAllocatedLeave(actor, payload);
  }
}
