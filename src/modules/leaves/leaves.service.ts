import {
  BadRequestException,
  ForbiddenException,
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
const HOURS_NEGATIVE_TOLERANCE = 1e-6;

type LeaveBalanceDelta = Partial<{
  balanceHours: number;
  pendingHours: number;
  bookedHours: number;
}>;

interface LeaveBalanceSnapshot {
  id: number;
  balanceHours: number;
  pendingHours: number;
  bookedHours: number;
}

@Injectable()
export class LeavesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly calendarService: CalendarService
  ) {}

  async listBalances(userId: number) {
    const db = this.database.connection;

    const rows = await db
      .select({
        id: leaveBalancesTable.id,
        leaveTypeId: leaveBalancesTable.leaveTypeId,
        balanceHours: leaveBalancesTable.balanceHours,
        pendingHours: leaveBalancesTable.pendingHours,
        bookedHours: leaveBalancesTable.bookedHours,
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

    const balances = rows.map((row) => ({
      id: row.id,
      leaveTypeId: row.leaveTypeId,
      balanceHours: this.normalizeHours(Number(row.balanceHours ?? 0)),
      pendingHours: this.normalizeHours(Number(row.pendingHours ?? 0)),
      bookedHours: this.normalizeHours(Number(row.bookedHours ?? 0)),
      asOfDate: row.asOfDate,
      leaveType: row.leaveType,
    }));

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

  async listLeaveRequests(params: ListLeaveRequestsParams = {}) {
    const db = this.database.connection;

    const filters = [];
    if (params.state) {
      filters.push(eq(leaveRequestsTable.state, params.state));
    }
    if (params.managerId) {
      filters.push(eq(usersTable.managerId, params.managerId));
    }

    const baseQuery = db
      .select({
        id: leaveRequestsTable.id,
        userId: leaveRequestsTable.userId,
        leaveTypeId: leaveRequestsTable.leaveTypeId,
        state: leaveRequestsTable.state,
        startDate: leaveRequestsTable.startDate,
        endDate: leaveRequestsTable.endDate,
        durationType: leaveRequestsTable.durationType,
        halfDaySegment: leaveRequestsTable.halfDaySegment,
        hours: leaveRequestsTable.hours,
        reason: leaveRequestsTable.reason,
        requestedAt: leaveRequestsTable.requestedAt,
        updatedAt: leaveRequestsTable.updatedAt,
        decidedByUserId: leaveRequestsTable.decidedByUserId,
        leaveTypeName: leaveTypesTable.name,
        leaveTypeCode: leaveTypesTable.code,
        requesterName: usersTable.name,
        requesterEmail: usersTable.email,
        managerId: usersTable.managerId,
      })
      .from(leaveRequestsTable)
      .innerJoin(usersTable, eq(usersTable.id, leaveRequestsTable.userId))
      .innerJoin(
        leaveTypesTable,
        eq(leaveRequestsTable.leaveTypeId, leaveTypesTable.id),
      );

    const query = filters.length > 0 ? baseQuery.where(and(...filters)) : baseQuery;

    const rows = await query.orderBy(desc(leaveRequestsTable.requestedAt));

    return rows.map((row) => ({
      id: row.id,
      user: {
        id: Number(row.userId),
        name: row.requesterName ?? null,
        email: row.requesterEmail ?? null,
      },
      managerId: row.managerId !== null && row.managerId !== undefined ? Number(row.managerId) : null,
      leaveType: {
        id: Number(row.leaveTypeId),
        name: row.leaveTypeName,
        code: row.leaveTypeCode ?? null,
      },
      state: row.state,
      startDate: row.startDate,
      endDate: row.endDate,
      durationType: row.durationType,
      halfDaySegment: row.halfDaySegment ?? null,
      hours: row.hours ? Number(row.hours) : 0,
      reason: row.reason ?? null,
      requestedAt: row.requestedAt,
      updatedAt: row.updatedAt,
      decidedByUserId: row.decidedByUserId ?? null,
    }));
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

      let balanceSnapshot: LeaveBalanceSnapshot | null = null;
      if (leaveType.paid) {
        balanceSnapshot = await this.fetchLeaveBalanceSnapshot(
          tx,
          userId,
          payload.leaveTypeId
        );

        if (balanceSnapshot.balanceHours < requestedHours) {
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

      if (leaveType.requiresApproval) {
        if (leaveType.paid) {
          if (!balanceSnapshot) {
            throw new BadRequestException(
              "Leave balance not found for user and leave type"
            );
          }

          balanceSnapshot = await this.updateLeaveBalanceFromSnapshot(
            tx,
            balanceSnapshot,
            {
              balanceHours: -requestedHours,
              pendingHours: requestedHours,
            }
          );
        }

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
      } else if (leaveType.paid) {
        if (!balanceSnapshot) {
          throw new BadRequestException(
            "Leave balance not found for user and leave type"
          );
        }

        await this.updateLeaveBalanceFromSnapshot(tx, balanceSnapshot, {
          balanceHours: -requestedHours,
          bookedHours: requestedHours,
        });
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
        .select({
          id: leaveRequestsTable.id,
          state: leaveRequestsTable.state,
          userId: leaveRequestsTable.userId,
          hours: leaveRequestsTable.hours,
          managerId: usersTable.managerId,
          leaveTypeId: leaveRequestsTable.leaveTypeId,
          leaveTypePaid: leaveTypesTable.paid,
        })
        .from(leaveRequestsTable)
        .innerJoin(
          usersTable,
          eq(usersTable.id, leaveRequestsTable.userId)
        )
        .innerJoin(
          leaveTypesTable,
          eq(leaveTypesTable.id, leaveRequestsTable.leaveTypeId)
        )
        .where(eq(leaveRequestsTable.id, requestId))
        .limit(1);

      if (!request) {
        throw new NotFoundException("Leave request not found");
      }

      if (!approverId) {
        throw new ForbiddenException(
          "You are not authorized to review this leave request"
        );
      }

      const [approver] = await tx
        .select({
          id: usersTable.id,
          role: usersTable.rolePrimary,
        })
        .from(usersTable)
        .where(eq(usersTable.id, approverId))
        .limit(1);

      if (!approver) {
        throw new ForbiddenException(
          "You are not authorized to review this leave request"
        );
      }

      const isAdmin =
        approver.role === "admin" || approver.role === "super_admin";

      if (!isAdmin) {
        if (request.managerId === null || request.managerId !== approverId) {
          throw new ForbiddenException(
            "You are not authorized to review this leave request"
          );
        }
      }

      const previousState = request.state;
      const requestedHours = Number(request.hours ?? 0);

      if (action === "approve" && previousState !== "pending") {
        throw new BadRequestException(
          `Only pending leave requests can be approved (current state: ${previousState})`
        );
      }

      if (
        action === "reject" &&
        previousState !== "pending" &&
        previousState !== "approved"
      ) {
        throw new BadRequestException(
          `Only pending or approved leave requests can be rejected (current state: ${previousState})`
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
          decision: newState,
          comment: payload.comment ?? null,
          decidedAt: now,
        })
        .where(
          and(
            eq(approvalsTable.subjectType, "leave_request"),
            eq(approvalsTable.subjectId, requestId)
          )
        );

      if (request.leaveTypePaid) {
        if (action === "approve") {
          await this.adjustLeaveBalance(tx, request.userId, request.leaveTypeId, {
            pendingHours: -requestedHours,
            bookedHours: requestedHours,
          });
        } else if (previousState === "pending") {
          await this.adjustLeaveBalance(tx, request.userId, request.leaveTypeId, {
            pendingHours: -requestedHours,
            balanceHours: requestedHours,
          });
        } else if (previousState === "approved") {
          await this.adjustLeaveBalance(tx, request.userId, request.leaveTypeId, {
            bookedHours: -requestedHours,
            balanceHours: requestedHours,
          });
        }
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
      if (!approverId) {
        throw new ForbiddenException(
          "You are not authorized to review these leave requests"
        );
      }

      const [approver] = await tx
        .select({
          id: usersTable.id,
          role: usersTable.rolePrimary,
        })
        .from(usersTable)
        .where(eq(usersTable.id, approverId))
        .limit(1);

      if (!approver) {
        throw new ForbiddenException(
          "You are not authorized to review these leave requests"
        );
      }

      const isAdmin =
        approver.role === "admin" || approver.role === "super_admin";

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
        .select({
          id: leaveRequestsTable.id,
          userId: leaveRequestsTable.userId,
          state: leaveRequestsTable.state,
          hours: leaveRequestsTable.hours,
          managerId: usersTable.managerId,
          leaveTypeId: leaveRequestsTable.leaveTypeId,
          leaveTypePaid: leaveTypesTable.paid,
        })
        .from(leaveRequestsTable)
        .innerJoin(
          usersTable,
          eq(usersTable.id, leaveRequestsTable.userId)
        )
        .innerJoin(
          leaveTypesTable,
          eq(leaveTypesTable.id, leaveRequestsTable.leaveTypeId)
        )
        .where(whereClause);

      if (candidates.length === 0) {
        throw new NotFoundException(
          "No leave requests matched the selection criteria."
        );
      }

      const managedCandidates = isAdmin
        ? candidates
        : candidates.filter((candidate) => candidate.managerId === approverId);

      if (managedCandidates.length === 0) {
        throw new ForbiddenException(
          "You are not authorized to review these leave requests"
        );
      }

      const eligible = managedCandidates.filter((request) =>
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
            inArray(approvalsTable.subjectId, eligibleIds)
          )
        );

      if (action === "approve") {
        for (const request of eligible) {
          if (!request.leaveTypePaid) {
            continue;
          }
          const hours = Number(request.hours ?? 0);
          await this.adjustLeaveBalance(tx, request.userId, request.leaveTypeId, {
            pendingHours: -hours,
            bookedHours: hours,
          });
        }
      } else {
        for (const request of eligible) {
          if (!request.leaveTypePaid) {
            continue;
          }

          const hours = Number(request.hours ?? 0);
          if (request.state === "approved") {
            await this.adjustLeaveBalance(tx, request.userId, request.leaveTypeId, {
              bookedHours: -hours,
              balanceHours: hours,
            });
          } else if (request.state === "pending") {
            await this.adjustLeaveBalance(tx, request.userId, request.leaveTypeId, {
              pendingHours: -hours,
              balanceHours: hours,
            });
          }
        }
      }

      const skipped = managedCandidates
        .filter((request) => !eligibleIdSet.has(request.id))
        .map((request) => ({
          id: request.id,
          state: request.state,
        }));

      evaluatedIds = evaluatedIds ?? managedCandidates.map((request) => request.id);

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

  private normalizeHours(value: number): number {
    const rounded = Math.round(value * 100) / 100;
    return Math.abs(rounded) < HOURS_NEGATIVE_TOLERANCE ? 0 : rounded;
  }

  private ensureNonNegative(value: number, label: string) {
    if (value < -HOURS_NEGATIVE_TOLERANCE) {
      throw new BadRequestException(
        `Leave ${label} hours cannot be negative after the requested operation`
      );
    }
  }

  private formatHours(value: number): string {
    return this.normalizeHours(value).toFixed(2);
  }

  private applyDeltas(
    snapshot: LeaveBalanceSnapshot,
    deltas: LeaveBalanceDelta
  ): LeaveBalanceSnapshot {
    const balanceHours = this.normalizeHours(
      snapshot.balanceHours + (deltas.balanceHours ?? 0)
    );
    const pendingHours = this.normalizeHours(
      snapshot.pendingHours + (deltas.pendingHours ?? 0)
    );
    const bookedHours = this.normalizeHours(
      snapshot.bookedHours + (deltas.bookedHours ?? 0)
    );

    this.ensureNonNegative(balanceHours, "balance");
    this.ensureNonNegative(pendingHours, "pending");
    this.ensureNonNegative(bookedHours, "booked");

    return {
      id: snapshot.id,
      balanceHours,
      pendingHours,
      bookedHours,
    };
  }

  private async fetchLeaveBalanceSnapshot(
    tx: DatabaseService["connection"],
    userId: number,
    leaveTypeId: number
  ): Promise<LeaveBalanceSnapshot> {
    const [row] = await tx
      .select({
        id: leaveBalancesTable.id,
        balanceHours: leaveBalancesTable.balanceHours,
        pendingHours: leaveBalancesTable.pendingHours,
        bookedHours: leaveBalancesTable.bookedHours,
      })
      .from(leaveBalancesTable)
      .where(
        and(
          eq(leaveBalancesTable.userId, userId),
          eq(leaveBalancesTable.leaveTypeId, leaveTypeId)
        )
      )
      .orderBy(desc(leaveBalancesTable.asOfDate))
      .limit(1);

    if (!row) {
      throw new BadRequestException(
        "Leave balance not found for user and leave type"
      );
    }

    return {
      id: row.id,
      balanceHours: Number(row.balanceHours ?? 0),
      pendingHours: Number(row.pendingHours ?? 0),
      bookedHours: Number(row.bookedHours ?? 0),
    };
  }

  private async updateLeaveBalanceFromSnapshot(
    tx: DatabaseService["connection"],
    snapshot: LeaveBalanceSnapshot,
    deltas: LeaveBalanceDelta
  ): Promise<LeaveBalanceSnapshot> {
    const next = this.applyDeltas(snapshot, deltas);

    await tx
      .update(leaveBalancesTable)
      .set({
        balanceHours: this.formatHours(next.balanceHours),
        pendingHours: this.formatHours(next.pendingHours),
        bookedHours: this.formatHours(next.bookedHours),
        updatedAt: new Date(),
      })
      .where(eq(leaveBalancesTable.id, snapshot.id));

    return next;
  }

  private async adjustLeaveBalance(
    tx: DatabaseService["connection"],
    userId: number,
    leaveTypeId: number,
    deltas: LeaveBalanceDelta
  ): Promise<LeaveBalanceSnapshot> {
    const snapshot = await this.fetchLeaveBalanceSnapshot(
      tx,
      userId,
      leaveTypeId
    );
    return this.updateLeaveBalanceFromSnapshot(tx, snapshot, deltas);
  }

  private isSecondOrFourthSaturday(date: Date): boolean {
    // date is already in UTC-safe form while iterating
    const occurrence = Math.ceil(date.getUTCDate() / 7);
    return occurrence === 2 || occurrence === 4;
  }
}








