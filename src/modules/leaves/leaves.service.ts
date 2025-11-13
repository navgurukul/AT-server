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
  sql,
} from "drizzle-orm";

import { DatabaseService } from "../../database/database.service";
import {
  approvalsTable,
  compOffCreditsTable,
  leaveBalancesTable,
  leavePoliciesTable,
  leaveRequestsTable,
  leaveTypesTable,
  timesheetsTable,
  usersTable,
} from "../../db/schema";
import { CalendarService } from "../calendar/calendar.service";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";
import { BulkReviewLeaveRequestsDto } from "./dto/bulk-review-leave-requests.dto";
import { ReviewLeaveRequestDto } from "./dto/review-leave-request.dto";
import { GrantCompOffDto } from "./dto/grant-comp-off.dto";
import { RevokeCompOffDto } from "./dto/revoke-comp-off.dto";
import { AuthenticatedUser } from "../../common/types/authenticated-user.interface";

interface ListLeaveRequestsParams {
  state?: "pending" | "approved" | "rejected" | "cancelled";
  managerId?: number;
}

interface ListCompOffParams {
  userId?: number;
  status?: "granted" | "expired" | "revoked";
}

const HOURS_PER_WORKING_DAY = 8;
const HALF_DAY_HOURS = HOURS_PER_WORKING_DAY / 2;
const HOURS_NEGATIVE_TOLERANCE = 1e-6;
const COMP_OFF_LEAVE_CODE = "COMP_OFF";
const COMP_OFF_FULL_DAY_HOURS = HOURS_PER_WORKING_DAY;
const COMP_OFF_HALF_DAY_HOURS = COMP_OFF_FULL_DAY_HOURS / 2;
const COMP_OFF_EXPIRY_DAYS = 30;

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

    const [userOrg] = await db
      .select({ orgId: usersTable.orgId })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (userOrg?.orgId) {
      await this.expireCompOffForUserIfNeeded(
        db,
        userId,
        Number(userOrg.orgId)
      );
    }

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

      const requiresApproval =
        leaveType.requiresApproval === undefined ||
        leaveType.requiresApproval === null
          ? true
          : leaveType.requiresApproval;
      const isPaidLeave = leaveType.paid ?? true;

      let balanceSnapshot: LeaveBalanceSnapshot | null = null;
      if (isPaidLeave) {
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
          state: requiresApproval ? "pending" : "approved",
          requestedAt: new Date(),
        })
        .returning();

      if (requiresApproval) {
        if (isPaidLeave) {
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
      } else if (isPaidLeave) {
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

  async grantCompOffCredit(
    actor: AuthenticatedUser,
    payload: GrantCompOffDto
  ) {
    const db = this.database.connection;
    const workDate = this.normalizeDateUTC(new Date(payload.workDate));
    const workDateKey = this.formatDateKey(workDate);
    const today = this.normalizeDateUTC(new Date());

    if (workDate > today) {
      throw new BadRequestException(
        "Comp-off credits can only be granted for past or current dates"
      );
    }

    const creditHours =
      payload.duration === "half_day"
        ? COMP_OFF_HALF_DAY_HOURS
        : COMP_OFF_FULL_DAY_HOURS;
    const now = new Date();

    return db.transaction(async (tx) => {
      const [targetUser] = await tx
        .select({
          id: usersTable.id,
          orgId: usersTable.orgId,
          managerId: usersTable.managerId,
        })
        .from(usersTable)
        .where(eq(usersTable.id, payload.userId))
        .limit(1);

      if (!targetUser || targetUser.orgId !== actor.orgId) {
        throw new NotFoundException("User not found in this organisation");
      }

      const directManagerId =
        targetUser.managerId !== null && targetUser.managerId !== undefined
          ? Number(targetUser.managerId)
          : null;
      const isDirectManager = directManagerId === actor.id;
      const isPrivileged = this.hasOrgWideCompOffAccess(actor);

      if (!isDirectManager && !isPrivileged) {
        throw new ForbiddenException(
          "Only the employee's reporting manager or an administrator can grant comp-off credits"
        );
      }

      const dayInfo = await this.calendarService.getDayInfo(
        actor.orgId,
        workDate
      );

      if (dayInfo.isWorkingDay) {
        throw new BadRequestException(
          "Comp-off credits can only be granted for non-working days"
        );
      }

      const [timesheet] = await tx
        .select({
          id: timesheetsTable.id,
          totalHours: timesheetsTable.totalHours,
        })
        .from(timesheetsTable)
        .where(
          and(
            eq(timesheetsTable.userId, payload.userId),
            eq(timesheetsTable.orgId, actor.orgId),
            eq(timesheetsTable.workDate, workDate)
          )
        )
        .limit(1);

      if (!timesheet) {
        throw new BadRequestException(
          "No timesheet exists for the selected date"
        );
      }

      const timesheetHours =
        timesheet.totalHours !== null && timesheet.totalHours !== undefined
          ? Number(timesheet.totalHours)
          : 0;

      const requiredHours =
        payload.duration === "half_day"
          ? COMP_OFF_HALF_DAY_HOURS
          : COMP_OFF_FULL_DAY_HOURS;

      if (timesheetHours < requiredHours) {
        throw new BadRequestException(
          `Timesheet must record at least ${requiredHours} hours for a ${payload.duration.replace(
            "_",
            " "
          )} comp-off`
        );
      }

      const [{ creditedSoFar }] = await tx
        .select({
          creditedSoFar: sql<number>`COALESCE(SUM(${compOffCreditsTable.creditedHours}), 0)`,
        })
        .from(compOffCreditsTable)
        .where(
          and(
            eq(compOffCreditsTable.orgId, actor.orgId),
            eq(compOffCreditsTable.userId, payload.userId),
            eq(
              compOffCreditsTable.workDate,
              sql`CAST(${workDateKey} AS date)`
            ),
            eq(compOffCreditsTable.status, "granted")
          )
        );

      const totalForDay = Number(creditedSoFar ?? 0) + creditHours;
      if (totalForDay - HOURS_NEGATIVE_TOLERANCE > COMP_OFF_FULL_DAY_HOURS) {
        throw new BadRequestException(
          "Cannot credit more than one full day of comp-off for a single date"
        );
      }

      const leaveTypeId = await this.ensureCompOffLeaveType(tx, actor.orgId);
      await this.ensureLeaveBalanceRow(tx, payload.userId, leaveTypeId);

      await this.expireStaleCompOffCredits(
        tx,
        actor.orgId,
        payload.userId,
        leaveTypeId,
        now
      );

      let snapshot = await this.fetchLeaveBalanceSnapshot(
        tx,
        payload.userId,
        leaveTypeId
      );

      snapshot = await this.updateLeaveBalanceFromSnapshot(tx, snapshot, {
        balanceHours: creditHours,
      });

      const expiresAt = new Date(workDate);
      expiresAt.setUTCDate(expiresAt.getUTCDate() + COMP_OFF_EXPIRY_DAYS);

      const creditedHoursValue = creditHours.toFixed(2);
      const timesheetHoursValue = timesheetHours.toFixed(2);

      const [credit] = await tx
        .insert(compOffCreditsTable)
        .values({
          orgId: actor.orgId,
          userId: payload.userId,
          managerId: directManagerId ?? actor.id,
          createdBy: actor.id,
          timesheetId: timesheet.id,
          workDate: sql`CAST(${workDateKey} AS date)`,
          durationType: payload.duration,
          creditedHours: creditedHoursValue,
          timesheetHours: timesheetHoursValue,
          status: "granted",
          expiresAt,
          notes: payload.notes ?? null,
        })
        .returning({
          id: compOffCreditsTable.id,
          workDate: compOffCreditsTable.workDate,
          durationType: compOffCreditsTable.durationType,
          creditedHours: compOffCreditsTable.creditedHours,
          status: compOffCreditsTable.status,
          expiresAt: compOffCreditsTable.expiresAt,
          notes: compOffCreditsTable.notes,
        });

      return {
        credit: {
          id: credit.id,
          workDate: credit.workDate,
          durationType: credit.durationType,
          creditedHours: Number(credit.creditedHours ?? 0),
          status: credit.status,
          expiresAt: credit.expiresAt,
          notes: credit.notes ?? null,
        },
        balance: {
          leaveTypeId,
          balanceHours: snapshot.balanceHours,
          pendingHours: snapshot.pendingHours,
          bookedHours: snapshot.bookedHours,
        },
      };
    });
  }

  async listCompOffCredits(
    actor: AuthenticatedUser,
    params: ListCompOffParams = {}
  ) {
    const db = this.database.connection;
    const targetUserId = params.userId ?? actor.id;

    const [targetUser] = await db
      .select({
        id: usersTable.id,
        orgId: usersTable.orgId,
        managerId: usersTable.managerId,
        name: usersTable.name,
      })
      .from(usersTable)
      .where(eq(usersTable.id, targetUserId))
      .limit(1);

    if (!targetUser || Number(targetUser.orgId) !== actor.orgId) {
      throw new NotFoundException("User not found in this organisation");
    }

    const isSelf = targetUser.id === actor.id;
    if (!isSelf && !this.canAccessOtherCompOff(actor, targetUser)) {
      throw new ForbiddenException(
        "You do not have permission to view comp-off credits for this user"
      );
    }

    await this.expireCompOffForUserIfNeeded(db, targetUser.id, actor.orgId);

    const filters = [
      eq(compOffCreditsTable.orgId, actor.orgId),
      eq(compOffCreditsTable.userId, targetUser.id),
    ];

    if (params.status) {
      filters.push(eq(compOffCreditsTable.status, params.status));
    }

    const rows = await db
      .select({
        id: compOffCreditsTable.id,
        workDate: compOffCreditsTable.workDate,
        durationType: compOffCreditsTable.durationType,
        creditedHours: compOffCreditsTable.creditedHours,
        timesheetHours: compOffCreditsTable.timesheetHours,
        status: compOffCreditsTable.status,
        expiresAt: compOffCreditsTable.expiresAt,
        notes: compOffCreditsTable.notes,
        createdAt: compOffCreditsTable.createdAt,
        updatedAt: compOffCreditsTable.updatedAt,
      })
      .from(compOffCreditsTable)
      .where(and(...filters))
      .orderBy(
        desc(compOffCreditsTable.workDate),
        desc(compOffCreditsTable.createdAt)
      );

    return {
      user: {
        id: targetUser.id,
        name: targetUser.name,
        managerId:
          targetUser.managerId !== null && targetUser.managerId !== undefined
            ? Number(targetUser.managerId)
            : null,
      },
      credits: rows.map((row) => ({
        id: row.id,
        workDate: row.workDate,
        durationType: row.durationType,
        creditedHours: Number(row.creditedHours ?? 0),
        timesheetHours: Number(row.timesheetHours ?? 0),
        status: row.status,
        expiresAt: row.expiresAt,
        notes: row.notes ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    };
  }

  async revokeCompOffCredit(
    actor: AuthenticatedUser,
    creditId: number,
    payload: RevokeCompOffDto
  ) {
    const db = this.database.connection;
    const now = new Date();

    return db.transaction(async (tx) => {
      const [credit] = await tx
        .select({
          id: compOffCreditsTable.id,
          orgId: compOffCreditsTable.orgId,
          userId: compOffCreditsTable.userId,
          managerId: compOffCreditsTable.managerId,
          status: compOffCreditsTable.status,
          creditedHours: compOffCreditsTable.creditedHours,
          notes: compOffCreditsTable.notes,
        })
        .from(compOffCreditsTable)
        .where(eq(compOffCreditsTable.id, creditId))
        .limit(1);

      if (!credit || Number(credit.orgId) !== actor.orgId) {
        throw new NotFoundException("Comp-off credit not found");
      }

      if (credit.status !== "granted") {
        throw new BadRequestException(
          "Only active comp-off credits can be revoked"
        );
      }

      const [targetUser] = await tx
        .select({
          id: usersTable.id,
          managerId: usersTable.managerId,
        })
        .from(usersTable)
        .where(eq(usersTable.id, credit.userId))
        .limit(1);

      if (!targetUser) {
        throw new NotFoundException("User not found for this comp-off");
      }

      const isAuthorized =
        (targetUser.managerId !== null &&
          targetUser.managerId !== undefined &&
          Number(targetUser.managerId) === actor.id) ||
        this.hasOrgWideCompOffAccess(actor);

      if (!isAuthorized) {
        throw new ForbiddenException(
          "Only the reporting manager or an administrator can revoke this comp-off"
        );
      }

      const leaveTypeId = await this.ensureCompOffLeaveType(tx, actor.orgId);
      await this.ensureLeaveBalanceRow(tx, credit.userId, leaveTypeId);

      let snapshot = await this.fetchLeaveBalanceSnapshot(
        tx,
        credit.userId,
        leaveTypeId
      );

      const creditHours = Number(credit.creditedHours ?? 0);
      if (creditHours > 0 && snapshot.balanceHours > 0) {
        const deduction = Math.min(snapshot.balanceHours, creditHours);
        if (deduction > 0) {
          snapshot = await this.updateLeaveBalanceFromSnapshot(tx, snapshot, {
            balanceHours: -deduction,
          });
        }
      }

      const updatedNotes = payload.reason
        ? `${credit.notes ? `${credit.notes} | ` : ""}Revoked: ${
            payload.reason
          }`
        : credit.notes ?? null;

      await tx
        .update(compOffCreditsTable)
        .set({
          status: "revoked",
          notes: updatedNotes,
          updatedAt: now,
        })
        .where(eq(compOffCreditsTable.id, credit.id));

      return {
        creditId: credit.id,
        status: "revoked",
        balance: {
          leaveTypeId,
          balanceHours: snapshot.balanceHours,
          pendingHours: snapshot.pendingHours,
          bookedHours: snapshot.bookedHours,
        },
      };
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

      const isPaidLeave = request.leaveTypePaid ?? true;

      if (isPaidLeave) {
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
          const isPaidLeave = request.leaveTypePaid ?? true;
          if (!isPaidLeave) {
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
          const isPaidLeave = request.leaveTypePaid ?? true;
          if (!isPaidLeave) {
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

  private hasOrgWideCompOffAccess(actor: AuthenticatedUser): boolean {
    const privilegedRoles = new Set(["admin", "super_admin", "superadmin"]);
    return (actor.roles ?? []).some((role) => privilegedRoles.has(role));
  }

  private hasPermission(actor: AuthenticatedUser, permission: string): boolean {
    return (actor.permissions ?? []).includes(permission);
  }

  private canAccessOtherCompOff(
    actor: AuthenticatedUser,
    targetUser: { managerId: number | null | undefined }
  ): boolean {
    if (
      targetUser.managerId !== null &&
      targetUser.managerId !== undefined &&
      Number(targetUser.managerId) === actor.id
    ) {
      return true;
    }
    return (
      this.hasOrgWideCompOffAccess(actor) ||
      this.hasPermission(actor, "leave:view:team") ||
      this.hasPermission(actor, "leave:approve:team")
    );
  }

  private async findCompOffLeaveTypeId(
    tx: DatabaseService["connection"],
    orgId: number
  ): Promise<number | null> {
    const [row] = await tx
      .select({ id: leaveTypesTable.id })
      .from(leaveTypesTable)
      .where(
        and(
          eq(leaveTypesTable.orgId, orgId),
          eq(leaveTypesTable.code, COMP_OFF_LEAVE_CODE)
        )
      )
      .limit(1);

    return row ? row.id : null;
  }

  private async ensureCompOffLeaveType(
    tx: DatabaseService["connection"],
    orgId: number
  ): Promise<number> {
    let [leaveType] = await tx
      .select({
        id: leaveTypesTable.id,
      })
      .from(leaveTypesTable)
      .where(
        and(
          eq(leaveTypesTable.orgId, orgId),
          eq(leaveTypesTable.code, COMP_OFF_LEAVE_CODE)
        )
      )
      .limit(1);

    if (!leaveType) {
      [leaveType] = await tx
        .insert(leaveTypesTable)
        .values({
          orgId,
          code: COMP_OFF_LEAVE_CODE,
          name: "Comp Off",
          paid: true,
          requiresApproval: true,
          description: "Compensatory off credit",
        })
        .returning({
          id: leaveTypesTable.id,
        });
    }

    const [policy] = await tx
      .select({ id: leavePoliciesTable.id })
      .from(leavePoliciesTable)
      .where(
        and(
          eq(leavePoliciesTable.orgId, orgId),
          eq(leavePoliciesTable.leaveTypeId, leaveType.id)
        )
      )
      .limit(1);

    if (!policy) {
      await tx.insert(leavePoliciesTable).values({
        orgId,
        leaveTypeId: leaveType.id,
        accrualRule: null,
        carryForwardRule: null,
        maxBalance: null,
      });
    }

    return leaveType.id;
  }

  private async ensureLeaveBalanceRow(
    tx: DatabaseService["connection"],
    userId: number,
    leaveTypeId: number
  ) {
    const [existing] = await tx
      .select({ id: leaveBalancesTable.id })
      .from(leaveBalancesTable)
      .where(
        and(
          eq(leaveBalancesTable.userId, userId),
          eq(leaveBalancesTable.leaveTypeId, leaveTypeId)
        )
      )
      .limit(1);

    if (!existing) {
      await tx.insert(leaveBalancesTable).values({
        userId,
        leaveTypeId,
        balanceHours: "0",
        pendingHours: "0",
        bookedHours: "0",
        asOfDate: this.formatDateKey(this.normalizeDateUTC(new Date())),
      });
    }
  }

  private async expireCompOffForUserIfNeeded(
    tx: DatabaseService["connection"],
    userId: number,
    orgId: number
  ) {
    const leaveTypeId = await this.findCompOffLeaveTypeId(tx, orgId);
    if (!leaveTypeId) {
      return;
    }

    const [balance] = await tx
      .select({ id: leaveBalancesTable.id })
      .from(leaveBalancesTable)
      .where(
        and(
          eq(leaveBalancesTable.userId, userId),
          eq(leaveBalancesTable.leaveTypeId, leaveTypeId)
        )
      )
      .limit(1);

    if (!balance) {
      return;
    }

    await this.expireStaleCompOffCredits(tx, orgId, userId, leaveTypeId, new Date());
  }

  private async expireStaleCompOffCredits(
    tx: DatabaseService["connection"],
    orgId: number,
    userId: number,
    leaveTypeId: number,
    referenceDate: Date
  ) {
    const credits = await tx
      .select({
        id: compOffCreditsTable.id,
        creditedHours: compOffCreditsTable.creditedHours,
      })
      .from(compOffCreditsTable)
      .where(
        and(
          eq(compOffCreditsTable.orgId, orgId),
          eq(compOffCreditsTable.userId, userId),
          eq(compOffCreditsTable.status, "granted"),
          lt(compOffCreditsTable.expiresAt, referenceDate)
        )
      );

    if (credits.length === 0) {
      return;
    }

    let snapshot = await this.fetchLeaveBalanceSnapshot(
      tx,
      userId,
      leaveTypeId
    );

    for (const credit of credits) {
      const creditHours = Number(credit.creditedHours ?? 0);
      if (creditHours > 0 && snapshot.balanceHours > 0) {
        const deduction = Math.min(snapshot.balanceHours, creditHours);
        if (deduction > 0) {
          snapshot = await this.updateLeaveBalanceFromSnapshot(tx, snapshot, {
            balanceHours: -deduction,
          });
        }
      }

      await tx
        .update(compOffCreditsTable)
        .set({
          status: "expired",
          updatedAt: referenceDate,
        })
        .where(eq(compOffCreditsTable.id, credit.id));
    }
  }

  private normalizeDateUTC(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    );
  }

  private formatDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
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
