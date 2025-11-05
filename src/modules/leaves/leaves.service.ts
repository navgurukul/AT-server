import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  lte,
  or,
  lt,
  sql,
} from "drizzle-orm";

import { DatabaseService } from "../../database/database.service";
import {
  approvalsTable,
  leaveBalancesTable,
  leavePoliciesTable,
  leaveRequestsTable,
  leaveTypesTable,
  usersTable,
} from "../../db/schema";
import { CalendarService } from "../calendar/calendar.service";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";
import { BulkReviewLeaveRequestsDto } from "./dto/bulk-review-leave-requests.dto";
import { ReviewLeaveRequestDto } from "./dto/review-leave-request.dto";

interface ListLeaveRequestsParams {
  state?: "pending" | "approved" | "rejected" | "cancelled";
  managerId?: number;
}

const HOURS_PER_WORKING_DAY = 8;
const HALF_DAY_HOURS = HOURS_PER_WORKING_DAY / 2;

@Injectable()
export class LeavesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly calendarService: CalendarService
  ) {}

  async listBalances(userId: number) {
    const db = this.database.connection;

    const balances = await db
      .select({
        id: leaveBalancesTable.id,
        leaveTypeId: leaveBalancesTable.leaveTypeId,
        balanceHours: leaveBalancesTable.balanceHours,
        asOfDate: leaveBalancesTable.asOfDate,
        leaveType: {
          id: leaveTypesTable.id,
          code: leaveTypesTable.code,
          name: leaveTypesTable.name,
          paid: leaveTypesTable.paid,
          requiresApproval: leaveTypesTable.requiresApproval,
        },
      })
      .from(leaveBalancesTable)
      .innerJoin(
        leaveTypesTable,
        eq(leaveBalancesTable.leaveTypeId, leaveTypesTable.id)
      )
      .where(eq(leaveBalancesTable.userId, userId));

    return {
      userId,
      balances,
    };
  }

  async listLeaveTypes(orgId: number) {
    const db = this.database.connection;

    const types = await db
      .select({
        id: leaveTypesTable.id,
        code: leaveTypesTable.code,
        name: leaveTypesTable.name,
        paid: leaveTypesTable.paid,
        requiresApproval: leaveTypesTable.requiresApproval,
        description: leaveTypesTable.description,
        maxPerRequestHours: leaveTypesTable.maxPerRequestHours,
      })
      .from(leaveTypesTable)
      .where(eq(leaveTypesTable.orgId, orgId));

    return types;
  }

  async createLeaveRequest(
    userId: number,
    orgId: number,
    payload: CreateLeaveRequestDto
  ) {
    const db = this.database.connection;
    const startDate = new Date(payload.startDate);
    const endDate = new Date(payload.endDate);

    if (endDate < startDate) {
      throw new BadRequestException("End date cannot be before start date");
    }

    return await db.transaction(async (tx) => {
      const [leaveType] = await tx
        .select()
        .from(leaveTypesTable)
        .where(
          and(
            eq(leaveTypesTable.id, payload.leaveTypeId),
            eq(leaveTypesTable.orgId, orgId)
          )
        )
        .limit(1);

      if (!leaveType) {
        throw new NotFoundException(
          "Leave type not found for this organisation"
        );
      }

      const [policy] = await tx
        .select()
        .from(leavePoliciesTable)
        .where(
          and(
            eq(leavePoliciesTable.leaveTypeId, payload.leaveTypeId),
            eq(leavePoliciesTable.orgId, orgId)
          )
        )
        .limit(1);

      if (!policy) {
        throw new BadRequestException(
          "No leave policy configured for the selected leave type"
        );
      }

      await this.assertNoHolidays(orgId, startDate, endDate);

      const { workingDays, totalHours } = await this.calculateWorkingHours(
        orgId,
        startDate,
        endDate
      );

      if (totalHours <= 0) {
        throw new BadRequestException(
          "Selected date range contains no working days"
        );
      }

      if (payload.hours !== undefined && payload.hours <= 0) {
        throw new BadRequestException("Leave hours must be greater than zero");
      }

      let requestedDurationType: "half_day" | "full_day" | "custom";
      let requestedHours: number;
      let requestedHalfDaySegment: "first_half" | "second_half" | null = null;

      switch (payload.durationType) {
        case "half_day":
          if (workingDays !== 1) {
            throw new BadRequestException(
              "Half-day requests must span a single working day"
            );
          }
          if (!payload.halfDaySegment) {
            throw new BadRequestException(
              "Half-day requests must specify whether it is the first or second half"
            );
          }
          requestedDurationType = "half_day";
          requestedHours = HALF_DAY_HOURS;
          requestedHalfDaySegment = payload.halfDaySegment;
          break;
        case "full_day":
          requestedDurationType = "full_day";
          requestedHours = totalHours;
          break;
        case "custom":
          if (payload.hours === undefined) {
            throw new BadRequestException(
              "Custom duration requires leave hours to be specified"
            );
          }
          requestedDurationType = "custom";
          requestedHours = payload.hours;
          break;
        default:
          if (payload.hours !== undefined) {
            requestedDurationType = "custom";
            requestedHours = payload.hours;
          } else {
            requestedDurationType = "full_day";
            requestedHours = totalHours;
          }
      }

      if (
        payload.halfDaySegment &&
        requestedDurationType !== "half_day"
      ) {
        throw new BadRequestException(
          "Half-day segment can only be provided for half-day requests"
        );
      }

      if (requestedHours <= 0) {
        throw new BadRequestException("Leave hours must be greater than zero");
      }

      if (requestedHours > totalHours) {
        throw new BadRequestException(
          `Requested hours exceed available working hours (${totalHours})`
        );
      }

      const requestedDays = requestedHours / HOURS_PER_WORKING_DAY;

      const overlappingRequests = await tx
        .select({ value: count(leaveRequestsTable.id) })
        .from(leaveRequestsTable)
        .where(
          and(
            eq(leaveRequestsTable.userId, userId),
            inArray(leaveRequestsTable.state, ["pending", "approved"]),
            or(
              and(
                gte(leaveRequestsTable.startDate, startDate),
                lte(leaveRequestsTable.startDate, endDate)
              ),
              and(
                gte(leaveRequestsTable.endDate, startDate),
                lte(leaveRequestsTable.endDate, endDate)
              ),
              and(
                lte(leaveRequestsTable.startDate, startDate),
                gte(leaveRequestsTable.endDate, endDate)
              )
            )
          )
        );

      if (Number(overlappingRequests[0]?.value ?? 0) > 0) {
        throw new BadRequestException(
          "Overlapping leave request exists for the selected period"
        );
      }

      if (leaveType.paid) {
        const [balance] = await tx
          .select()
          .from(leaveBalancesTable)
          .where(
            and(
              eq(leaveBalancesTable.userId, userId),
              eq(leaveBalancesTable.leaveTypeId, payload.leaveTypeId)
            )
          )
          .limit(1);

        if (!balance || Number(balance.balanceHours) < requestedDays) {
          throw new BadRequestException(
            "Insufficient leave balance for this leave type"
          );
        }
      }

      const [request] = await tx
        .insert(leaveRequestsTable)
        .values({
          orgId,
          userId,
          leaveTypeId: payload.leaveTypeId,
          startDate,
          endDate,
          durationType: requestedDurationType,
          halfDaySegment: requestedHalfDaySegment,
          hours: requestedHours.toString(),
          reason: payload.reason ?? null,
          state: leaveType.requiresApproval ? "pending" : "approved",
          requestedAt: new Date(),
        })
        .returning();

      if (!leaveType.requiresApproval) {
        await this.applyLeaveBalance(tx, request.id, requestedHours);
      } else {
        const [user] = await tx
          .select({
            managerId: usersTable.managerId,
          })
          .from(usersTable)
          .where(eq(usersTable.id, userId))
          .limit(1);

        if (user?.managerId) {
          await tx
            .insert(approvalsTable)
            .values({
              orgId,
              subjectType: "leave_request",
              subjectId: request.id,
              approverId: user.managerId,
              decision: "pending",
            })
            .onConflictDoNothing();
        }
      }

      return request;
    });
  }

  async reviewLeaveRequest(
    requestId: number,
    action: "approve" | "reject",
    payload: ReviewLeaveRequestDto,
    approverId: number
  ) {
    const db = this.database.connection;

    return await db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(leaveRequestsTable)
        .where(eq(leaveRequestsTable.id, requestId))
        .limit(1);

      if (!request) {
        throw new NotFoundException("Leave request not found");
      }

      if (!["pending", "approved"].includes(request.state)) {
        throw new BadRequestException(
          `Leave request in state ${request.state} cannot be updated`
        );
      }

      const newState = action === "approve" ? "approved" : "rejected";
      const now = new Date();

      const [updated] = await tx
        .update(leaveRequestsTable)
        .set({
          state: newState,
          decidedByUserId: approverId,
          updatedAt: now,
        })
        .where(eq(leaveRequestsTable.id, requestId))
        .returning();

      await tx
        .update(approvalsTable)
        .set({
          decision: newState === "approved" ? "approved" : "rejected",
          comment: payload.comment ?? null,
          decidedAt: now,
        })
        .where(
          and(
            eq(approvalsTable.subjectType, "leave_request"),
            eq(approvalsTable.subjectId, requestId),
            eq(approvalsTable.approverId, approverId)
          )
        );

      if (newState === "approved") {
        await this.applyLeaveBalance(tx, requestId, Number(request.hours));
      } else if (request.state === "approved" && newState === "rejected") {
        await this.restoreLeaveBalance(tx, requestId, Number(request.hours));
      }

      return updated;
    });
  }

  async bulkReviewLeaveRequests(
    payload: BulkReviewLeaveRequestsDto,
    action: "approve" | "reject",
    approverId: number
  ) {
    if (
      (!payload.requestIds || payload.requestIds.length === 0) &&
      (payload.month === undefined || payload.year === undefined)
    ) {
      throw new BadRequestException(
        "Provide either requestIds or both month and year for bulk review."
      );
    }

    const db = this.database.connection;

    return await db.transaction(async (tx) => {
      const filters = [eq(leaveRequestsTable.userId, payload.userId)];
      let evaluatedIds: number[] | undefined;

      if (payload.requestIds?.length) {
        evaluatedIds = Array.from(new Set(payload.requestIds));
        filters.push(inArray(leaveRequestsTable.id, evaluatedIds));
      } else {
        const year = payload.year as number;
        const month = payload.month as number;
        const start = new Date(Date.UTC(year, month - 1, 1));
        const startOfNextMonth = new Date(Date.UTC(year, month, 1));
        filters.push(gte(leaveRequestsTable.startDate, start));
        filters.push(lt(leaveRequestsTable.startDate, startOfNextMonth));
      }

      const whereClause = filters.length === 1 ? filters[0] : and(...filters);

      const candidates = await tx
        .select()
        .from(leaveRequestsTable)
        .where(whereClause);

      if (candidates.length === 0) {
        throw new NotFoundException(
          "No leave requests matched the selection criteria."
        );
      }

      const eligible = candidates.filter((request) =>
        action === "approve"
          ? request.state === "pending"
          : request.state === "pending" || request.state === "approved"
      );

      if (eligible.length === 0) {
        throw new BadRequestException(
          `No leave requests are eligible to be ${action}d in their current state.`
        );
      }

      const newState = action === "approve" ? "approved" : "rejected";
      const eligibleIds = eligible.map((request) => request.id);
      const eligibleIdSet = new Set(eligibleIds);
      const now = new Date();

      await tx
        .update(leaveRequestsTable)
        .set({
          state: newState,
          decidedByUserId: approverId,
          updatedAt: now,
        })
        .where(inArray(leaveRequestsTable.id, eligibleIds));

      await tx
        .update(approvalsTable)
        .set({
          decision: newState,
          comment: payload.comment ?? null,
          decidedAt: now,
        })
        .where(
          and(
            eq(approvalsTable.subjectType, "leave_request"),
            eq(approvalsTable.approverId, approverId),
            inArray(approvalsTable.subjectId, eligibleIds)
          )
        );

      if (action === "approve") {
        for (const request of eligible) {
          await this.applyLeaveBalance(
            tx,
            request.id,
            Number(request.hours ?? 0)
          );
        }
      } else {
        for (const request of eligible) {
          if (request.state === "approved") {
            await this.restoreLeaveBalance(
              tx,
              request.id,
              Number(request.hours ?? 0)
            );
          }
        }
      }

      const skipped = candidates
        .filter((request) => !eligibleIdSet.has(request.id))
        .map((request) => ({
          id: request.id,
          state: request.state,
        }));

      evaluatedIds = evaluatedIds ?? candidates.map((request) => request.id);

      return {
        action,
        newState,
        updatedCount: eligibleIds.length,
        updatedRequestIds: eligibleIds,
        evaluatedRequestIds: evaluatedIds,
        skipped,
      };
    });
  }

  async listLeaveRequests(params: ListLeaveRequestsParams) {
    const db = this.database.connection;

    const filters = [];
    if (params.state) {
      filters.push(eq(leaveRequestsTable.state, params.state));
    }

    if (params.managerId) {
      filters.push(eq(usersTable.managerId, params.managerId));
    }

    const whereClause = filters.length ? and(...filters) : undefined;

    const baseQuery = db
      .select({
        id: leaveRequestsTable.id,
        userId: leaveRequestsTable.userId,
        leaveTypeId: leaveRequestsTable.leaveTypeId,
        startDate: leaveRequestsTable.startDate,
        endDate: leaveRequestsTable.endDate,
        hours: leaveRequestsTable.hours,
        durationType: leaveRequestsTable.durationType,
        halfDaySegment: leaveRequestsTable.halfDaySegment,
        reason: leaveRequestsTable.reason,
        state: leaveRequestsTable.state,
        requestedAt: leaveRequestsTable.requestedAt,
        leaveTypeName: leaveTypesTable.name,
        leaveTypeCode: leaveTypesTable.code,
        userName: usersTable.name,
        userEmail: usersTable.email,
      })
      .from(leaveRequestsTable)
      .innerJoin(
        leaveTypesTable,
        eq(leaveRequestsTable.leaveTypeId, leaveTypesTable.id)
      )
      .innerJoin(usersTable, eq(leaveRequestsTable.userId, usersTable.id));

    const filteredQuery = whereClause
      ? baseQuery.where(whereClause)
      : baseQuery;

    const requests = await filteredQuery.orderBy(
      desc(leaveRequestsTable.requestedAt)
    );

    return requests;
  }

  private async assertNoHolidays(
    orgId: number,
    startDate: Date,
    endDate: Date
  ) {
    const start = new Date(
      Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate()
      )
    );

    const finish = new Date(
      Date.UTC(
        endDate.getUTCFullYear(),
        endDate.getUTCMonth(),
        endDate.getUTCDate()
      )
    );

    const cursor = new Date(start);
    while (cursor <= finish) {
      if (await this.calendarService.isHoliday(orgId, cursor)) {
        throw new BadRequestException(
          `Cannot request leave on holiday or non-working day ${cursor
            .toISOString()
            .slice(0, 10)}`
        );
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  private async calculateWorkingHours(
    orgId: number,
    startDate: Date,
    endDate: Date
  ) {
    const start = new Date(
      Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate()
      )
    );
    const finish = new Date(
      Date.UTC(
        endDate.getUTCFullYear(),
        endDate.getUTCMonth(),
        endDate.getUTCDate()
      )
    );

    const holidayMap = await this.calendarService.getHolidayMap(
      orgId,
      start,
      finish
    );

    let workingDays = 0;
    const cursor = new Date(start);
    while (cursor <= finish) {
      const dayOfWeek = cursor.getUTCDay();
      const override = holidayMap.get(cursor.toISOString().slice(0, 10));
      const isSunday = dayOfWeek === 0;
      const isSecondOrFourthSaturday =
        dayOfWeek === 6 && this.isSecondOrFourthSaturday(cursor);
      const defaultWorkingDay = !(isSunday || isSecondOrFourthSaturday);
      const isWorkingDay = override ? override.isWorkingDay : defaultWorkingDay;

      if (isWorkingDay) {
        workingDays += 1;
      }

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return {
      workingDays,
      totalHours: workingDays * HOURS_PER_WORKING_DAY,
    };
  }

  private async applyLeaveBalance(
    tx: DatabaseService["connection"],
    requestId: number,
    hours: number
  ) {
    const [request] = await tx
      .select({
        userId: leaveRequestsTable.userId,
        leaveTypeId: leaveRequestsTable.leaveTypeId,
      })
      .from(leaveRequestsTable)
      .where(eq(leaveRequestsTable.id, requestId))
      .limit(1);

    if (!request) {
      throw new NotFoundException("Leave request not found");
    }

    const [balance] = await tx
      .select({
        id: leaveBalancesTable.id,
        balanceHours: leaveBalancesTable.balanceHours,
      })
      .from(leaveBalancesTable)
      .where(
        and(
          eq(leaveBalancesTable.userId, request.userId),
          eq(leaveBalancesTable.leaveTypeId, request.leaveTypeId)
        )
      )
      .limit(1);

    if (!balance) {
      throw new BadRequestException(
        "Leave balance not found for user and leave type"
      );
    }

    const requestedDays = hours / HOURS_PER_WORKING_DAY;
    const remaining = Number(balance.balanceHours) - requestedDays;
    if (remaining < 0) {
      throw new BadRequestException(
        "Insufficient leave balance to approve this request"
      );
    }

    await tx
      .update(leaveBalancesTable)
      .set({
        balanceHours: String(Number(remaining.toFixed(2))),
        updatedAt: new Date(),
      })
      .where(eq(leaveBalancesTable.id, balance.id));
  }

  private async restoreLeaveBalance(
    tx: DatabaseService["connection"],
    requestId: number,
    hours: number
  ) {
    const [request] = await tx
      .select({
        userId: leaveRequestsTable.userId,
        leaveTypeId: leaveRequestsTable.leaveTypeId,
      })
      .from(leaveRequestsTable)
      .where(eq(leaveRequestsTable.id, requestId))
      .limit(1);

    if (!request) {
      return;
    }

    await tx
      .update(leaveBalancesTable)
      .set({
        balanceHours: sql`${leaveBalancesTable.balanceHours}::numeric + ${hours / HOURS_PER_WORKING_DAY}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(leaveBalancesTable.userId, request.userId),
          eq(leaveBalancesTable.leaveTypeId, request.leaveTypeId)
        )
      );
  }

  private isSecondOrFourthSaturday(date: Date): boolean {
    // date is already in UTC-safe form while iterating
    const occurrence = Math.ceil(date.getUTCDate() / 7);
    return occurrence === 2 || occurrence === 4;
  }
}
