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
  isNotNull,
  isNull,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { DatabaseService } from "../../database/database.service";
import {
  approvalsTable,
  compOffCreditsTable,
  leaveBalancesTable,
  leavePoliciesTable,
  payableDaysTable,
  leaveRequestsTable,
  leaveTypesTable,
  notificationsTable,
  projectsTable,
  rolesTable,
  timesheetEntriesTable,
  timesheetsTable,
  orgHolidaysTable,
  userRoles,
  usersTable,
  users,
} from "../../db/schema";
import { CalendarService } from "../calendar/calendar.service";
import { AuditService } from "../audit/audit.service";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";
import { CreateLeaveForUserDto } from "./dto/create-leave-for-user.dto";
import { BulkReviewLeaveIdsDto } from "./dto/bulk-review-leave-ids.dto";
import { ReviewLeaveRequestDto } from "./dto/review-leave-request.dto";
import { GrantCompOffDto } from "./dto/grant-comp-off.dto";
import { RevokeCompOffDto } from "./dto/revoke-comp-off.dto";
import { UpdateAllocatedLeaveDto } from "./dto/update-allocated-leave.dto";
import { AuthenticatedUser } from "../../common/types/authenticated-user.interface";
import { SalaryCycleUtil } from "../../common/utils/salary-cycle.util";
import { checkAdminSelfAction } from '../../common/utils/self-action.utils';

interface ListLeaveRequestsParams {
  actor?: AuthenticatedUser;
  state?: "pending" | "approved" | "rejected" | "cancelled";
  managerId?: number;
  excludeUserId?: number;
}

interface ListCompOffParams {
  userId?: number;
  email?: string;
  workDate?: string;
  holidayType?: string;
  status?: "pending" | "granted" | "expired" | "revoked";
}

interface CompOffCreditListRow {
  id: number;
  userId: number;
  workDate: Date | string;
  durationType: string;
  creditedHours: number | string | null;
  timesheetHours: number | string | null;
  status: string;
  expiresAt: Date | string;
  leaveRequestId: number | null;
}

export interface MyCompOffCreditItem {
  workDate: string | Date;
  holidayType: string;
  duration: "full_day" | "half_day" | string;
  timesheetHours: number;
  creditedHours: number;
  availedDate: Date | string | null;
  expireDate: Date | string;
  status:
    | "pending"
    | "granted"
    | "expired"
    | "revoked"
    | "partial_availed"
    | string;
}

const HOURS_PER_WORKING_DAY = 8;
const HALF_DAY_HOURS = HOURS_PER_WORKING_DAY / 2;
const HOURS_NEGATIVE_TOLERANCE = 1e-6;
const COMP_OFF_LEAVE_CODE = "COMP_OFF";
const LWP_LEAVE_CODE = "LWP";
const COMP_OFF_FULL_DAY_HOURS = HOURS_PER_WORKING_DAY;
const COMP_OFF_HALF_DAY_HOURS = COMP_OFF_FULL_DAY_HOURS / 2;
const COMP_OFF_EXPIRY_DAYS = 30;

type LeaveBalanceDelta = Partial<{
  balanceHours: number;
  pendingHours: number;
  bookedHours: number;
  allocatedHours: number;
}>;

interface LeaveBalanceSnapshot {
  id: number;
  balanceHours: number;
  pendingHours: number;
  bookedHours: number;
  allocatedHours: number;
}

@Injectable()
export class LeavesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly calendarService: CalendarService,
    private readonly auditService: AuditService,
  ) {}

  private async consumeCompOffCredits(
    tx: DatabaseService['connection'],
    userId: number,
    hoursToConsume: number,
    leaveRequestId?: number,
  ) {
    const activeCreditConditions = and(
      eq(compOffCreditsTable.userId, userId),
      inArray(compOffCreditsTable.status, ['granted', 'partial_availed']),
    );

    const linkedCredits = leaveRequestId
      ? await tx
          .select()
          .from(compOffCreditsTable)
          .where(
            and(
              activeCreditConditions,
              eq(compOffCreditsTable.leaveRequestId, leaveRequestId),
            ),
          )
          .orderBy(compOffCreditsTable.workDate)
      : [];

    const unlinkedCredits = await tx
      .select()
      .from(compOffCreditsTable)
      .where(
        and(
          activeCreditConditions,
          leaveRequestId
            ? isNull(compOffCreditsTable.leaveRequestId)
            : sql`true`,
        ),
      )
      .orderBy(compOffCreditsTable.workDate);

    const credits = [...linkedCredits, ...unlinkedCredits];

    let remainingHoursToConsume = hoursToConsume;

    for (const credit of credits) {
      if (remainingHoursToConsume <= 0) {
        break;
      }

      const availableHours = Number(credit.creditedHours) - Number(credit.availedHours);
      const hoursToTake = Math.min(remainingHoursToConsume, availableHours);

      if (hoursToTake > 0) {
        const newAvailedHours = Number(credit.availedHours) + hoursToTake;
        const newStatus =
          newAvailedHours >= Number(credit.creditedHours)
            ? 'availed'
            : 'partial_availed';

        await tx
          .update(compOffCreditsTable)
          .set({
            availedHours: newAvailedHours.toString(),
            status: newStatus,
            leaveRequestId: leaveRequestId ?? credit.leaveRequestId,
          })
          .where(eq(compOffCreditsTable.id, credit.id));

        remainingHoursToConsume -= hoursToTake;
      }
    }

    if (remainingHoursToConsume > 0) {
      throw new Error('Insufficient comp-off credits to consume');
    }
  }

  private async revertCompOffCredit(
    tx: DatabaseService['connection'],
    compOffCreditId: number,
    leaveTypeId: number,
    userId: number,
  ): Promise<boolean> {
    const [grantedCredit] = await tx
      .select({
        id: compOffCreditsTable.id,
        creditedHours: compOffCreditsTable.creditedHours,
        userId: compOffCreditsTable.userId,
      })
      .from(compOffCreditsTable)
      .where(
        and(
          eq(compOffCreditsTable.id, compOffCreditId),
          eq(compOffCreditsTable.status, 'granted'),
        ),
      )
      .limit(1);

    if (!grantedCredit) {
      return false;
    }

    const hoursToRevert = Number(grantedCredit.creditedHours ?? 0);
    if (hoursToRevert <= 0) {
      return false;
    }

    const balanceSnapshot = await this.fetchLeaveBalanceSnapshot(
      tx,
      userId,
      leaveTypeId,
    );

    await this.updateLeaveBalanceFromSnapshot(tx, balanceSnapshot, {
      balanceHours: -hoursToRevert,
      allocatedHours: -hoursToRevert,
    });

    await tx
    .update(compOffCreditsTable)
    .set({
      status: 'pending',
      timesheetId: null,
      creditedHours: '0',
      timesheetHours: null,
    })
    .where(eq(compOffCreditsTable.id, grantedCredit.id));
    return true;
  }

  private async linkCompOffCreditsToLeaveRequest(
    tx: DatabaseService['connection'],
    userId: number,
    hoursToLink: number,
    leaveRequestId: number,
  ) {
    const credits = await tx
      .select()
      .from(compOffCreditsTable)
      .where(
        and(
          eq(compOffCreditsTable.userId, userId),
          inArray(compOffCreditsTable.status, ['granted', 'partial_availed']),
          isNull(compOffCreditsTable.leaveRequestId),
        ),
      )
      .orderBy(compOffCreditsTable.workDate);

    let remainingHoursToLink = hoursToLink;

    for (const credit of credits) {
      if (remainingHoursToLink <= 0) {
        break;
      }

      const availableHours = Number(credit.creditedHours) - Number(credit.availedHours);
      const hoursToLinkNow = Math.min(remainingHoursToLink, availableHours);

      if (hoursToLinkNow > 0) {
        await tx
          .update(compOffCreditsTable)
          .set({
            leaveRequestId,
          })
          .where(eq(compOffCreditsTable.id, credit.id));

        remainingHoursToLink -= hoursToLinkNow;
      }
    }

    if (remainingHoursToLink > 0) {
      throw new Error('Insufficient comp-off credits to link to leave request');
    }
  }

  private async clearCompOffCreditLinks(
    tx: DatabaseService['connection'],
    leaveRequestId: number,
  ) {
    await tx
      .update(compOffCreditsTable)
      .set({
        leaveRequestId: null,
      })
      .where(eq(compOffCreditsTable.leaveRequestId, leaveRequestId));
  }

  async listBalances(userId: number) {
    const db = this.database.connection;

    const [userOrg] = await db
      .select({ orgId: usersTable.orgId })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (userOrg?.orgId) {
      await this.expireGrantedCompOffForUserIfNeeded(
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
        allocatedHours: leaveBalancesTable.allocatedHours,
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
      allocatedHours: this.normalizeHours(Number(row.allocatedHours ?? 0)),
      asOfDate: row.asOfDate,
      leaveType: row.leaveType,
    }));

    return {
      userId,
      balances,
    };
  }

  async listBalancesForActor(
    actor: AuthenticatedUser,
    requestedUserId?: number
  ) {
    if (!requestedUserId || Number.isNaN(requestedUserId)) {
      return this.listBalances(actor.id);
    }

    if (requestedUserId === actor.id) {
      return this.listBalances(actor.id);
    }

    const db = this.database.connection;

    const [targetUser] = await db
      .select({
        id: usersTable.id,
        orgId: usersTable.orgId,
        managerId: usersTable.managerId,
      })
      .from(usersTable)
      .where(eq(usersTable.id, requestedUserId))
      .limit(1);

    if (!targetUser || Number(targetUser.orgId) !== actor.orgId) {
      throw new NotFoundException("User not found in this organisation");
    }

    if (this.hasOrgWideLeaveBalanceAccess(actor)) {
      return this.listBalances(requestedUserId);
    }

    const isDirectReport =
      targetUser.managerId !== null &&
      targetUser.managerId !== undefined &&
      Number(targetUser.managerId) === actor.id;

    if (this.isReportingManager(actor) && isDirectReport) {
      return this.listBalances(requestedUserId);
    }

    throw new ForbiddenException(
      "You can only view leave balances for your direct reports"
    );
  }

  async listBalancesForActorByEmail(
    actor: AuthenticatedUser,
    requestedEmail: string
  ) {
    const normalizedEmail = requestedEmail.trim().toLowerCase();

    if (!normalizedEmail) {
      throw new BadRequestException("email is required");
    }

    if (normalizedEmail === actor.email.trim().toLowerCase()) {
      return this.listBalances(actor.id);
    }

    const db = this.database.connection;

    const [targetUser] = await db
      .select({
        id: usersTable.id,
        orgId: usersTable.orgId,
        managerId: usersTable.managerId,
      })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.orgId, actor.orgId),
          sql`lower(${usersTable.email}) = ${normalizedEmail}`
        )
      )
      .limit(1);

    if (!targetUser) {
      throw new NotFoundException("User not found in this organisation");
    }

    if (this.hasOrgWideLeaveBalanceAccess(actor)) {
      return this.listBalances(targetUser.id);
    }

    const isDirectReport =
      targetUser.managerId !== null &&
      targetUser.managerId !== undefined &&
      Number(targetUser.managerId) === actor.id;

    if (this.isReportingManager(actor) && isDirectReport) {
      return this.listBalances(targetUser.id);
    }

    throw new ForbiddenException(
      "You can only view leave balances for your direct reports"
    );
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

    // Always exclude the current user's own leave requests
    if (params.excludeUserId || params.actor?.id) {
      filters.push(sql`${leaveRequestsTable.userId} != ${params.excludeUserId ?? params.actor?.id}`);
    }

    // Filter by manager's mentees if actor is provided and no explicit managerId is specified
    if (params.actor && !params.managerId) {
      // Admin and superadmin can see all employee leaves (except their own)
      const isAdmin = params.actor.roles?.includes("admin");
      const isSuperAdmin = params.actor.roles?.includes("super_admin");
      
      if (!isAdmin && !isSuperAdmin) {
        // Manager: Only show leave requests from their direct reports (mentees)
        const mentees = await db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(
            and(
              eq(usersTable.managerId, params.actor.id),
              eq(usersTable.orgId, params.actor.orgId)
            )
          );

        const menteeIds = mentees.map((m) => m.id);
        if (menteeIds.length === 0) {
          // Manager has no mentees, return empty list
          return [];
        }
        filters.push(inArray(leaveRequestsTable.userId, menteeIds));
      } else {
        // Admin/Superadmin: filter by organization (own requests already excluded above)
        filters.push(eq(usersTable.orgId, params.actor.orgId));
      }
    }

    // Additional guard: never show non-working-day requests in this listing logic
    // (handled at creation time), so existing data is trusted here.

    const decidedByUser = alias(users, "decidedByUser");

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
        decidedByUserName: decidedByUser.name,
      })
      .from(leaveRequestsTable)
      .innerJoin(usersTable, eq(usersTable.id, leaveRequestsTable.userId))
      .innerJoin(
        leaveTypesTable,
        eq(leaveRequestsTable.leaveTypeId, leaveTypesTable.id),
      )
      .leftJoin(
        decidedByUser,
        eq(leaveRequestsTable.decidedByUserId, decidedByUser.id),
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
      decidedByUserName: row.decidedByUserName ?? null,
    }));
  }

  async listUserLeaveHistory(
    userId: number,
    orgId: number,
    params: { from?: string; to?: string } = {}
  ) {
    const db = this.database.connection;
    const { from, to } = params;

    const fromDate = from ? this.normalizeDateUTC(new Date(from)) : undefined;
    const toDate = to
      ? this.normalizeDateUTC(new Date(to))
      : fromDate ?? undefined;

    const conditions = [
      eq(leaveRequestsTable.orgId, orgId),
      eq(leaveRequestsTable.userId, userId),
    ];
    if (fromDate) {
      conditions.push(gte(leaveRequestsTable.endDate, fromDate));
    }
    if (toDate) {
      conditions.push(lte(leaveRequestsTable.startDate, toDate));
    }

    const rows = await db
      .select({
        id: leaveRequestsTable.id,
        startDate: leaveRequestsTable.startDate,
        endDate: leaveRequestsTable.endDate,
        durationType: leaveRequestsTable.durationType,
        halfDaySegment: leaveRequestsTable.halfDaySegment,
        hours: leaveRequestsTable.hours,
        reason: leaveRequestsTable.reason,
        state: leaveRequestsTable.state,
        requestedAt: leaveRequestsTable.requestedAt,
        updatedAt: leaveRequestsTable.updatedAt,
        leaveType: {
          id: leaveTypesTable.id,
          code: leaveTypesTable.code,
          name: leaveTypesTable.name,
        },
      })
      .from(leaveRequestsTable)
      .innerJoin(
        leaveTypesTable,
        eq(leaveRequestsTable.leaveTypeId, leaveTypesTable.id),
      )
      .where(and(...conditions))
      .orderBy(desc(leaveRequestsTable.requestedAt));

    return rows.map((row) => ({
      id: row.id,
      startDate: row.startDate,
      endDate: row.endDate,
      durationType: row.durationType,
      halfDaySegment: row.halfDaySegment ?? null,
      hours: row.hours ? Number(row.hours) : 0,
      reason: row.reason ?? null,
      state: row.state,
      requestedAt: row.requestedAt,
      updatedAt: row.updatedAt,
      leaveType: row.leaveType,
    }));
  }
  async createLeaveRequest(
    userId: number,
    orgId: number,
    payload: CreateLeaveRequestDto,
    actor?: AuthenticatedUser,
  ) {
    const db = this.database.connection;
    const startDate = new Date(payload.startDate);
    const endDate = new Date(payload.endDate);
    let requiresApproval = true;
    let isPaidLeave = true;
    let requestedDurationType: "half_day" | "full_day" | "custom" = "full_day";
    let requestedHours = 0;
    let requestedHalfDaySegment: "first_half" | "second_half" | null = null;

    if (endDate < startDate) {
      throw new BadRequestException("End date cannot be before start date");
    }

    this.enforcePastDateWindowForNonPrivilegedActor(startDate, endDate, actor);

    const request = await db.transaction(async (tx) => {
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

      switch (payload.durationType) {
        case "half_day":
          if (!payload.halfDaySegment) {
            throw new BadRequestException(
              "Half-day requests must specify whether it is the first or second half"
            );
          }
          requestedDurationType = "half_day";
          // Apply half-day hours to each working day in the range
          requestedHours = workingDays * HALF_DAY_HOURS;
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
        .select({ 
          id: leaveRequestsTable.id,
          durationType: leaveRequestsTable.durationType,
          halfDaySegment: leaveRequestsTable.halfDaySegment,
          startDate: leaveRequestsTable.startDate,
          endDate: leaveRequestsTable.endDate,
        })
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

      // Check for actual conflicts
      for (const existing of overlappingRequests) {
        // If both current and existing requests are half-day with different segments, they can coexist
        if (
          requestedDurationType === "half_day" &&
          existing.durationType === "half_day" &&
          requestedHalfDaySegment !== existing.halfDaySegment
        ) {
          // No conflict - different half-day segments can coexist
          continue; 
        }
        
        // Any other overlap is a conflict
        throw new BadRequestException(
          "Overlapping leave request exists for the selected period"
        );
      }

      requiresApproval =
        leaveType.requiresApproval === undefined ||
        leaveType.requiresApproval === null
          ? true
          : leaveType.requiresApproval;
      isPaidLeave = leaveType.paid ?? true;
      
      // Check if this is an LWP (Leave Without Pay) leave type
      const isLWP = leaveType.code === LWP_LEAVE_CODE || 
                    (leaveType.name?.toLowerCase().includes('without pay') ?? false);

      if (isLWP) {
        const lwpBalance = await this.fetchLeaveBalanceSnapshot(
          tx,
          userId,
          payload.leaveTypeId,
        );

        if (
          lwpBalance.balanceHours <= 0 ||
          requestedHours > lwpBalance.balanceHours
        ) {
          throw new BadRequestException(
            'Insufficient LWP balance. You cannot apply for more than your available balance.',
          );
        }
      }

      let balanceSnapshot: LeaveBalanceSnapshot | null = null;
      // Track balance for both paid leaves and LWP
      const shouldTrackBalance = isPaidLeave || isLWP;
      if (shouldTrackBalance) {
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

      if (await this.hasBlockingTimesheet(orgId, userId, startDate, endDate, requestedDurationType)) {
        throw new BadRequestException(
          "Cannot request leave for dates where timesheets already exist"
        );
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
          state: "pending",
          requestedAt: new Date(),
        })
        .returning();

      if (leaveType.code === COMP_OFF_LEAVE_CODE) {
        await this.linkCompOffCreditsToLeaveRequest(
          tx,
          userId,
          requestedHours,
          request.id,
        );
      }

      if (isPaidLeave || isLWP) {
        if (!balanceSnapshot) {
          throw new BadRequestException(
            "Leave balance not found for user and leave type",
          );
        }
        // For all paid leaves and LWP, move from balance to pending
        await this.updateLeaveBalanceFromSnapshot(tx, balanceSnapshot, {
          balanceHours: -requestedHours,
          pendingHours: requestedHours,
        });
      }

      return request;
    });

    // Fetch user and leave type details for notification
    const [userInfo] = await db
      .select({
        name: usersTable.name,
        slackId: usersTable.slackId,
        discordId: usersTable.discordId,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    const [leaveTypeInfo] = await db
      .select({
        name: leaveTypesTable.name,
      })
      .from(leaveTypesTable)
      .where(eq(leaveTypesTable.id, payload.leaveTypeId))
      .limit(1);

    const notificationPayload = {
      type: "leave_request",
      leaveId: request.id,
      startDate,
      endDate,
      durationType: requestedDurationType,
      halfDaySegment: requestedHalfDaySegment,
      state: isPaidLeave ? (requiresApproval ? "pending" : "approved") : "pending",
      userName: userInfo?.name ?? `User ${userId}`,
      userSlackId: userInfo?.slackId ?? null,
      userDiscordId: userInfo?.discordId ?? null,
      leaveTypeName: leaveTypeInfo?.name ?? "Leave",
      reason: payload.reason ?? null,
    };

    await this.notifyLatestProjectSlackChannel(userId, orgId, notificationPayload);

    const actorRole = this.getPrivilegedActorRole(actor?.roles ?? []);
    if (actorRole) {
      await this.auditService.createLog({
        orgId,
        actorUserId: actor?.id,
        actorRole,
        action: 'leave_applied',
        subjectType: 'leave_applied',
        targetUserId: userId,
        next: {
          userId,
          leaveTypeId: payload.leaveTypeId,
          startDate: payload.startDate,
          endDate: payload.endDate,
          durationType: requestedDurationType,
          hours: requestedHours,
          reason: payload.reason ?? null,
        },
      });
    }

    return request;
  }

  async createLeaveRequestForUser(
    actor: AuthenticatedUser,
    payload: CreateLeaveForUserDto
  ) {
    const db = this.database.connection;
    checkAdminSelfAction(actor, payload.userId.toString());

    // Verify the target user exists and belongs to the same organization
    const [targetUser] = await db
      .select({
        id: usersTable.id,
        orgId: usersTable.orgId,
      })
      .from(usersTable)
      .where(eq(usersTable.id, payload.userId))
      .limit(1);

    if (!targetUser) {
      throw new NotFoundException("User not found");
    }

    if (targetUser.orgId !== actor.orgId) {
      throw new ForbiddenException(
        "Cannot apply leave for users in a different organization"
      );
    }

    // Create leave request for the target user
    return this.createLeaveRequest(
      payload.userId,
      targetUser.orgId,
      payload,
      actor,
    );
  }

  async adminEditLeaveRequest(
    actor: AuthenticatedUser,
    requestId: number,
    payload: CreateLeaveRequestDto
  ) {
    const isPrivilegedActor =
      actor.roles.includes("admin") || actor.roles.includes("super_admin");

    if (!isPrivilegedActor) {
      throw new ForbiddenException(
        "Only admin and super_admin can edit leave applications"
      );
    }
    const db = this.database.connection;
    const startDate = new Date(payload.startDate);
    const endDate = new Date(payload.endDate);

    if (endDate < startDate) {
      throw new BadRequestException("End date cannot be before start date");
    }

    this.enforcePastDateWindowForNonPrivilegedActor(startDate, endDate, actor);

    return db.transaction(async (tx) => {
      const [existingRequest] = await tx
        .select({
          id: leaveRequestsTable.id,
          orgId: leaveRequestsTable.orgId,
          userId: leaveRequestsTable.userId,
          leaveTypeId: leaveRequestsTable.leaveTypeId,
          state: leaveRequestsTable.state,
          hours: leaveRequestsTable.hours,
          leaveTypePaid: leaveTypesTable.paid,
          leaveTypeCode: leaveTypesTable.code,
          leaveTypeName: leaveTypesTable.name,
          startDate: leaveRequestsTable.startDate,
          endDate: leaveRequestsTable.endDate,
          durationType: leaveRequestsTable.durationType,
          halfDaySegment: leaveRequestsTable.halfDaySegment,
          reason: leaveRequestsTable.reason,
        })
        .from(leaveRequestsTable)
        .innerJoin(
          leaveTypesTable,
          eq(leaveTypesTable.id, leaveRequestsTable.leaveTypeId)
        )
        .where(eq(leaveRequestsTable.id, requestId))
        .limit(1);

      if (!existingRequest) {
        throw new NotFoundException("Leave request not found");
      }
      checkAdminSelfAction(actor, existingRequest.userId.toString());

      if (Number(existingRequest.orgId) !== actor.orgId) {
        throw new ForbiddenException(
          "Cannot edit leave requests from a different organization"
        );
      }

      if (existingRequest.state !== "pending") {
        throw new BadRequestException(
          `Only pending leave requests can be edited (current state: ${existingRequest.state})`
        );
      }

      const [targetLeaveType] = await tx
        .select({
          id: leaveTypesTable.id,
          paid: leaveTypesTable.paid,
          code: leaveTypesTable.code,
          name: leaveTypesTable.name,
        })
        .from(leaveTypesTable)
        .where(
          and(
            eq(leaveTypesTable.id, payload.leaveTypeId),
            eq(leaveTypesTable.orgId, actor.orgId)
          )
        )
        .limit(1);

      if (!targetLeaveType) {
        throw new NotFoundException("Leave type not found for this organisation");
      }

      const [policy] = await tx
        .select({ id: leavePoliciesTable.id })
        .from(leavePoliciesTable)
        .where(
          and(
            eq(leavePoliciesTable.leaveTypeId, payload.leaveTypeId),
            eq(leavePoliciesTable.orgId, actor.orgId)
          )
        )
        .limit(1);

      if (!policy) {
        throw new BadRequestException(
          "No leave policy configured for the selected leave type"
        );
      }

      const { workingDays, totalHours } = await this.calculateWorkingHours(
        actor.orgId,
        startDate,
        endDate
      );

      if (totalHours <= 0) {
        throw new BadRequestException(
          "Selected date range contains no working days"
        );
      }

      let requestedDurationType: "half_day" | "full_day" | "custom" = "full_day";
      let requestedHours = 0;
      let requestedHalfDaySegment: "first_half" | "second_half" | null = null;

      switch (payload.durationType) {
        case "half_day":
          if (!payload.halfDaySegment) {
            throw new BadRequestException(
              "Half-day requests must specify whether it is the first or second half"
            );
          }
          requestedDurationType = "half_day";
          requestedHours = workingDays * HALF_DAY_HOURS;
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
        .select({
          id: leaveRequestsTable.id,
          durationType: leaveRequestsTable.durationType,
          halfDaySegment: leaveRequestsTable.halfDaySegment,
        })
        .from(leaveRequestsTable)
        .where(
          and(
            eq(leaveRequestsTable.userId, existingRequest.userId),
            inArray(leaveRequestsTable.state, ["pending", "approved"]),
            sql`${leaveRequestsTable.id} != ${requestId}`,
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

      for (const existing of overlappingRequests) {
        if (
          requestedDurationType === "half_day" &&
          existing.durationType === "half_day" &&
          requestedHalfDaySegment !== existing.halfDaySegment
        ) {
          continue;
        }

        throw new BadRequestException(
          "Overlapping leave request exists for the selected period"
        );
      }

      if (
        await this.hasBlockingTimesheet(
          actor.orgId,
          existingRequest.userId,
          startDate,
          endDate,
          requestedDurationType
        )
      ) {
        throw new BadRequestException(
          "Cannot request leave for dates where timesheets already exist"
        );
      }

      const previousHours = Number(existingRequest.hours ?? 0);
      const previousLeaveTypeId = Number(existingRequest.leaveTypeId);
      const previousPaidLeave = existingRequest.leaveTypePaid ?? true;
      const previousIsLWP = existingRequest.leaveTypeCode === LWP_LEAVE_CODE || 
                            (existingRequest.leaveTypeName?.toLowerCase().includes('without pay') ?? false);
      const previousShouldTrackBalance = previousPaidLeave || previousIsLWP;
      
      const nextPaidLeave = targetLeaveType.paid ?? true;
      const nextIsLWP = targetLeaveType.code === LWP_LEAVE_CODE || 
                        (targetLeaveType.name?.toLowerCase().includes('without pay') ?? false);
      const nextShouldTrackBalance = nextPaidLeave || nextIsLWP;

      if (previousShouldTrackBalance) {
        await this.ensureLeaveBalanceRow(
          tx,
          existingRequest.userId,
          previousLeaveTypeId
        );

        if (existingRequest.state === "pending") {
          await this.adjustLeaveBalance(tx, existingRequest.userId, previousLeaveTypeId, {
            balanceHours: previousHours,
            pendingHours: -previousHours,
          });
        } else {
          await this.adjustLeaveBalance(tx, existingRequest.userId, previousLeaveTypeId, {
            balanceHours: previousHours,
            bookedHours: -previousHours,
          });
        }
      }

      if (nextShouldTrackBalance) {
        await this.ensureLeaveBalanceRow(
          tx,
          existingRequest.userId,
          payload.leaveTypeId
        );

        const nextSnapshot = await this.fetchLeaveBalanceSnapshot(
          tx,
          existingRequest.userId,
          payload.leaveTypeId
        );

        if (nextSnapshot.balanceHours < requestedHours) {
          throw new BadRequestException(
            "Insufficient leave balance for this leave type"
          );
        }

        if (existingRequest.state === "pending") {
          await this.updateLeaveBalanceFromSnapshot(tx, nextSnapshot, {
            balanceHours: -requestedHours,
            pendingHours: requestedHours,
          });
        } else {
          await this.updateLeaveBalanceFromSnapshot(tx, nextSnapshot, {
            balanceHours: -requestedHours,
            bookedHours: requestedHours,
          });
        }
      }

      const [updatedRequest] = await tx
        .update(leaveRequestsTable)
        .set({
          leaveTypeId: payload.leaveTypeId,
          startDate,
          endDate,
          durationType: requestedDurationType,
          halfDaySegment: requestedHalfDaySegment,
          hours: requestedHours.toFixed(2),
          reason:
            payload.reason !== undefined
              ? payload.reason
              : existingRequest.reason ?? null,
          updatedAt: new Date(),
        })
        .where(eq(leaveRequestsTable.id, requestId))
        .returning({
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
          updatedAt: leaveRequestsTable.updatedAt,
        });

      const actorRole = this.getPrivilegedActorRole(actor.roles ?? []);
      if (actorRole) {
        await this.auditService.createLog({
          tx,
          orgId: actor.orgId,
          actorUserId: actor.id,
          actorRole,
          action: "leave_Edited",
          subjectType: "leave_modified",
          targetUserId: existingRequest.userId,
          prev: {
            id: existingRequest.id,
            leaveTypeId: previousLeaveTypeId,
            state: existingRequest.state,
            startDate: existingRequest.startDate,
            endDate: existingRequest.endDate,
            durationType: existingRequest.durationType,
            halfDaySegment: existingRequest.halfDaySegment,
            hours: previousHours,
            reason: existingRequest.reason ?? null,
          },
          next: {
            id: updatedRequest.id,
            leaveTypeId: updatedRequest.leaveTypeId,
            state: updatedRequest.state,
            startDate: updatedRequest.startDate,
            endDate: updatedRequest.endDate,
            durationType: updatedRequest.durationType,
            halfDaySegment: updatedRequest.halfDaySegment,
            hours: Number(updatedRequest.hours ?? 0),
            reason: updatedRequest.reason ?? null,
          },
        });
      }

      return {
        id: updatedRequest.id,
        userId: updatedRequest.userId,
        leaveTypeId: updatedRequest.leaveTypeId,
        state: updatedRequest.state,
        startDate: updatedRequest.startDate,
        endDate: updatedRequest.endDate,
        durationType: updatedRequest.durationType,
        halfDaySegment: updatedRequest.halfDaySegment,
        hours: Number(updatedRequest.hours ?? 0),
        reason: updatedRequest.reason ?? null,
        updatedAt: updatedRequest.updatedAt,
      };
    });
  }

  async adminDeleteApprovedLeaveRequest(
    actor: AuthenticatedUser,
    requestId: number
  ) {
    const isPrivilegedActor =
      actor.roles.includes("admin") || actor.roles.includes("super_admin");

    if (!isPrivilegedActor) {
      throw new ForbiddenException(
        "Only admin and super_admin can delete leave applications"
      );
    }

    const db = this.database.connection;
    const now = new Date();

    return db.transaction(async (tx) => {
      const [existingRequest] = await tx
        .select({
          id: leaveRequestsTable.id,
          orgId: leaveRequestsTable.orgId,
          userId: leaveRequestsTable.userId,
          leaveTypeId: leaveRequestsTable.leaveTypeId,
          state: leaveRequestsTable.state,
          hours: leaveRequestsTable.hours,
          leaveTypePaid: leaveTypesTable.paid,
          leaveTypeCode: leaveTypesTable.code,
          leaveTypeName: leaveTypesTable.name,
          startDate: leaveRequestsTable.startDate,
          endDate: leaveRequestsTable.endDate,
          durationType: leaveRequestsTable.durationType,
          halfDaySegment: leaveRequestsTable.halfDaySegment,
          reason: leaveRequestsTable.reason,
        })
        .from(leaveRequestsTable)
        .innerJoin(
          leaveTypesTable,
          eq(leaveTypesTable.id, leaveRequestsTable.leaveTypeId)
        )
        .where(eq(leaveRequestsTable.id, requestId))
        .limit(1);

      if (!existingRequest) {
        throw new NotFoundException("Leave request not found");
      }
      checkAdminSelfAction(actor, existingRequest.userId.toString());

      if (Number(existingRequest.orgId) !== actor.orgId) {
        throw new ForbiddenException(
          "Cannot delete leave requests from a different organization"
        );
      }

      if (existingRequest.state !== "approved") {
        throw new BadRequestException(
          `Only approved leave requests can be deleted (current state: ${existingRequest.state})`
        );
      }

      const approvedHours = Number(existingRequest.hours ?? 0);
      let updatedBalance: LeaveBalanceSnapshot | null = null;

      const isPaidLeave = existingRequest.leaveTypePaid ?? true;
      const isLWP = existingRequest.leaveTypeCode === LWP_LEAVE_CODE || 
                    (existingRequest.leaveTypeName?.toLowerCase().includes('without pay') ?? false);
      const shouldRestoreBalance = isPaidLeave || isLWP;

      if (shouldRestoreBalance) {
        await this.ensureLeaveBalanceRow(
          tx,
          existingRequest.userId,
          existingRequest.leaveTypeId
        );

        updatedBalance = await this.adjustLeaveBalance(
          tx,
          existingRequest.userId,
          existingRequest.leaveTypeId,
          {
            bookedHours: -approvedHours,
            balanceHours: approvedHours,
          }
        );
      }

      await tx
        .delete(approvalsTable)
        .where(
          and(
            eq(approvalsTable.subjectType, "leave_request"),
            eq(approvalsTable.subjectId, requestId)
          )
        );

      await tx
        .delete(leaveRequestsTable)
        .where(eq(leaveRequestsTable.id, requestId));

      const affectedCycles = this.getCycleRangesForDateWindow(
        new Date(existingRequest.startDate),
        new Date(existingRequest.endDate),
      );
      for (const cycle of affectedCycles) {
        await this.recalculateAndPersistPayableDaysForCycle(
          tx,
          actor.orgId,
          existingRequest.userId,
          cycle.cycleStart,
          cycle.cycleEnd,
          cycle.cycleKey,
          now,
        );
      }

      const actorRole = this.getPrivilegedActorRole(actor.roles ?? []);
      if (actorRole) {
        await this.auditService.createLog({
          tx,
          orgId: actor.orgId,
          actorUserId: actor.id,
          actorRole,
          action: "leave_deleted",
          subjectType: "leave_modified",
          targetUserId: existingRequest.userId,
          prev: {
            id: existingRequest.id,
            leaveTypeId: existingRequest.leaveTypeId,
            state: existingRequest.state,
            startDate: existingRequest.startDate,
            endDate: existingRequest.endDate,
            durationType: existingRequest.durationType,
            halfDaySegment: existingRequest.halfDaySegment,
            hours: approvedHours,
            reason: existingRequest.reason ?? null,
          },
          next: {
            deleted: true,
            restoredHours: approvedHours,
          },
        });
      }

      return {
        deletedRequestId: existingRequest.id,
        userId: existingRequest.userId,
        leaveTypeId: existingRequest.leaveTypeId,
        restoredHours: approvedHours,
        recalculatedBalance: updatedBalance
          ? {
              balanceHours: this.normalizeHours(updatedBalance.balanceHours),
              pendingHours: this.normalizeHours(updatedBalance.pendingHours),
              bookedHours: this.normalizeHours(updatedBalance.bookedHours),
            }
          : null,
      };
    });
  }

  async adminUpdateAllocatedLeave(
    actor: AuthenticatedUser,
    payload: UpdateAllocatedLeaveDto
  ) {
    const isPrivilegedActor =
      actor.roles.includes("admin") || actor.roles.includes("super_admin");

    if (!isPrivilegedActor) {
      throw new ForbiddenException(
        "Only admin and super_admin can update allocated leave"
      );
    }
    checkAdminSelfAction(actor, payload.userId.toString());

    const db = this.database.connection;

    return db.transaction(async (tx) => {
      const [targetUser] = await tx
        .select({ id: usersTable.id, orgId: usersTable.orgId })
        .from(usersTable)
        .where(eq(usersTable.id, payload.userId))
        .limit(1);

      if (!targetUser || Number(targetUser.orgId) !== actor.orgId) {
        throw new NotFoundException("User not found in this organisation");
      }

      const [leaveType] = await tx
        .select({ id: leaveTypesTable.id, orgId: leaveTypesTable.orgId })
        .from(leaveTypesTable)
        .where(eq(leaveTypesTable.id, payload.leaveTypeId))
        .limit(1);

      if (!leaveType || Number(leaveType.orgId) !== actor.orgId) {
        throw new NotFoundException(
          "Leave type not found in this organisation"
        );
      }

      await this.ensureLeaveBalanceRow(tx, payload.userId, payload.leaveTypeId);

      const snapshot = await this.fetchLeaveBalanceSnapshot(
        tx,
        payload.userId,
        payload.leaveTypeId
      );

      const nextAllocatedHours = this.normalizeHours(
        Number(payload.allocatedHours)
      );
      this.ensureNonNegative(nextAllocatedHours, "allocated");

      const recalculatedBalanceHours = this.normalizeHours(
        nextAllocatedHours - snapshot.pendingHours - snapshot.bookedHours
      );

      if (recalculatedBalanceHours < -HOURS_NEGATIVE_TOLERANCE) {
        throw new BadRequestException(
          "Allocated leave cannot be less than pending plus booked leave hours"
        );
      }

      const nextSnapshot: LeaveBalanceSnapshot = {
        id: snapshot.id,
        allocatedHours: nextAllocatedHours,
        balanceHours: recalculatedBalanceHours,
        pendingHours: snapshot.pendingHours,
        bookedHours: snapshot.bookedHours,
      };

      await tx
        .update(leaveBalancesTable)
        .set({
          balanceHours: this.formatHours(nextSnapshot.balanceHours),
          pendingHours: this.formatHours(nextSnapshot.pendingHours),
          bookedHours: this.formatHours(nextSnapshot.bookedHours),
          allocatedHours: this.formatHours(nextSnapshot.allocatedHours),
          updatedAt: new Date(),
        })
        .where(eq(leaveBalancesTable.id, snapshot.id));

      const actorRole = this.getPrivilegedActorRole(actor.roles ?? []);
      if (actorRole) {
        await this.auditService.createLog({
          tx,
          orgId: actor.orgId,
          actorUserId: actor.id,
          actorRole,
          action: "leave_balance_allocated_updated",
          subjectType: "leave_balance",
          targetUserId: payload.userId,
          prev: {
            leaveTypeId: payload.leaveTypeId,
            allocatedHours: this.normalizeHours(snapshot.allocatedHours),
            balanceHours: this.normalizeHours(snapshot.balanceHours),
            pendingHours: this.normalizeHours(snapshot.pendingHours),
            bookedHours: this.normalizeHours(snapshot.bookedHours),
          },
          next: {
            leaveTypeId: payload.leaveTypeId,
            allocatedHours: this.normalizeHours(nextSnapshot.allocatedHours),
            balanceHours: this.normalizeHours(nextSnapshot.balanceHours),
            pendingHours: this.normalizeHours(nextSnapshot.pendingHours),
            bookedHours: this.normalizeHours(nextSnapshot.bookedHours),
          },
        });
      }

      return {
        userId: payload.userId,
        leaveTypeId: payload.leaveTypeId,
        previous: {
          allocatedHours: this.normalizeHours(snapshot.allocatedHours),
          balanceHours: this.normalizeHours(snapshot.balanceHours),
          pendingHours: this.normalizeHours(snapshot.pendingHours),
          bookedHours: this.normalizeHours(snapshot.bookedHours),
        },
        recalculated: {
          allocatedHours: this.normalizeHours(nextSnapshot.allocatedHours),
          balanceHours: this.normalizeHours(nextSnapshot.balanceHours),
          pendingHours: this.normalizeHours(nextSnapshot.pendingHours),
          bookedHours: this.normalizeHours(nextSnapshot.bookedHours),
        },
      };
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
    const now = new Date();

    checkAdminSelfAction(actor, payload.userId.toString());
    return db.transaction(async (tx) => {
      // Validate user exists and actor has permission
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

      let isAuthorized = false;
      if (this.hasOrgWideCompOffAccess(actor)) {
        isAuthorized = true;
      } else {
        isAuthorized = await this.isManagerInHierarchy(
          tx,
          targetUser.id,
          actor.id,
        );
      }

      // Admin/SuperAdmin can raise for all employees; managers only for their reports
      if (!isAuthorized) {
        throw new ForbiddenException(
          'Only administrators or a manager in the reporting chain can authorize off-day work for an employee',
        );
      }

      // Must be a non-working day (weekend, holiday)
      const dayInfo = await this.calendarService.getDayInfo(actor.orgId, workDate);
      if (dayInfo.isWorkingDay) {
        throw new BadRequestException(
          "Off-day work requests can only be raised for non-working days (weekends, holidays)"
        );
      }

      // Prevent duplicate pending request for the same user/date.
      // Multiple granted credits on the same date are allowed while eligibility remains.
      const [existingRequest] = await tx
        .select({ id: compOffCreditsTable.id })
        .from(compOffCreditsTable)
        .where(
          and(
            eq(compOffCreditsTable.orgId, actor.orgId),
            eq(compOffCreditsTable.userId, payload.userId),
            eq(compOffCreditsTable.workDate, sql`CAST(${workDateKey} AS date)`),
            eq(compOffCreditsTable.status, "pending")
          )
        )
        .limit(1);

      if (existingRequest) {
        throw new BadRequestException(
          "A pending comp-off request already exists for this user and date"
        );
      }

      // Check if a timesheet already exists for this date
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

      const timesheetHours =
        timesheet?.totalHours !== null && timesheet?.totalHours !== undefined
          ? Number(timesheet.totalHours)
          : 0;

      if (timesheet && timesheetHours > 0) {
        const eligibility = this.calculateCompOffEligibility(timesheetHours);
        if (eligibility.durationType) {
          const [{ creditedSoFar }] = await tx
            .select({
              creditedSoFar: sql<number>`COALESCE(SUM(${compOffCreditsTable.creditedHours}), 0)`,
            })
            .from(compOffCreditsTable)
            .where(
              and(
                eq(compOffCreditsTable.orgId, actor.orgId),
                eq(compOffCreditsTable.userId, payload.userId),
                eq(compOffCreditsTable.workDate, sql`CAST(${workDateKey} AS date)`),
                eq(compOffCreditsTable.status, "granted")
              )
            );

          const remainingEligibilityHours =
            Number(eligibility.creditedHours ?? 0) - Number(creditedSoFar ?? 0);

          if (remainingEligibilityHours <= HOURS_NEGATIVE_TOLERANCE) {
            throw new BadRequestException(
              "Comp-off eligibility is already fully consumed for this work date"
            );
          }
        }
      }

      const expiresAt = this.calculateCompOffExpiryAt(workDate);

      // Create comp-off request in pending state. Balance will be updated only after timesheet is filled.
      const [workRequest] = await tx
        .insert(compOffCreditsTable)
        .values({
          orgId: actor.orgId,
          userId: payload.userId,
          managerId: directManagerId ?? actor.id,
          createdBy: actor.id,
          workDate: sql`CAST(${workDateKey} AS date)`,
          durationType: payload.duration,
          creditedHours: "0.00",
          timesheetHours: null,
          status: "pending",
          expiresAt,
          notes: payload.notes ?? null,
        })
        .returning({
          id: compOffCreditsTable.id,
          workDate: compOffCreditsTable.workDate,
          durationType: compOffCreditsTable.durationType,
          status: compOffCreditsTable.status,
          notes: compOffCreditsTable.notes,
          createdAt: compOffCreditsTable.createdAt,
        });

      // For future dates, no timesheet can exist yet — comp off pending
      if (workDate > today) {
        return {
          workRequest: {
            id: workRequest.id,
            workDate: workRequest.workDate,
            durationType: workRequest.durationType,
            status: workRequest.status,
            notes: workRequest.notes ?? null,
            createdAt: workRequest.createdAt,
          },
          compOff: {
            granted: false,
            reason:
              "Timesheet not yet available (future date). Comp off will be auto-credited once the employee fills the timesheet.",
          },
        };
      }

      if (!timesheet || timesheetHours === 0) {
        return {
          workRequest: {
            id: workRequest.id,
            workDate: workRequest.workDate,
            durationType: workRequest.durationType,
            status: workRequest.status,
            notes: workRequest.notes ?? null,
            createdAt: workRequest.createdAt,
          },
          compOff: {
            granted: false,
            reason:
              "No timesheet found for this date. Comp off will be auto-credited once the employee fills the timesheet.",
          },
        };
      }

      // Both conditions met — calculate comp off eligibility from actual hours
      const granted = await this.processCompOffCredit(
        tx,
        workRequest.id,
        timesheet.id,
        timesheetHours,
      );

      if (!granted) {
        return {
          workRequest: {
            id: workRequest.id,
            workDate: workRequest.workDate,
            durationType: workRequest.durationType,
            status: "pending",
            notes: workRequest.notes ?? null,
            createdAt: workRequest.createdAt,
          },
          compOff: {
            granted: false,
            reason:
              timesheetHours < 3
                ? `Timesheet has ${timesheetHours} hours which is below the minimum 3 hours required for comp off.`
                : "Comp-off request is pending and will be granted once validation is complete.",
          },
        };
      }

      const [credit] = await tx
        .select({
          id: compOffCreditsTable.id,
          workDate: compOffCreditsTable.workDate,
          durationType: compOffCreditsTable.durationType,
          creditedHours: compOffCreditsTable.creditedHours,
          timesheetHours: compOffCreditsTable.timesheetHours,
          status: compOffCreditsTable.status,
          expiresAt: compOffCreditsTable.expiresAt,
          notes: compOffCreditsTable.notes,
        })
        .from(compOffCreditsTable)
        .where(eq(compOffCreditsTable.id, workRequest.id))
        .limit(1);

      const leaveTypeId = await this.ensureCompOffLeaveType(tx, actor.orgId);
      let snapshot = await this.fetchLeaveBalanceSnapshot(tx, payload.userId, leaveTypeId);

      const actorRole = this.getPrivilegedActorRole(actor.roles ?? []);
      if (actorRole) {
        await this.auditService.createLog({
          tx,
          orgId: actor.orgId,
          actorUserId: actor.id,
          actorRole,
          action: 'comp_off_modified',
          subjectType: 'comp_off_modified',
          targetUserId: payload.userId,
          next: {
            userId: payload.userId,
            workDate: payload.workDate,
            duration: payload.duration,
            creditedHours: Number(credit.creditedHours ?? 0),
            status: credit.status,
          },
        });
      }

      return {
        workRequest: {
          id: workRequest.id,
          workDate: workRequest.workDate,
          durationType: workRequest.durationType,
          status: workRequest.status,
          notes: workRequest.notes ?? null,
          createdAt: workRequest.createdAt,
        },
        compOff: {
          granted: true,
          credit: {
            id: credit.id,
            workDate: credit.workDate,
            durationType: credit.durationType,
            creditedHours: Number(credit.creditedHours ?? 0),
            timesheetHours: Number(credit.timesheetHours ?? 0),
            status: credit.status,
            expiresAt: credit.expiresAt,
            notes: credit.notes ?? null,
          },
          balance: {
            leaveTypeId,
            balanceHours: snapshot.balanceHours,
            pendingHours: snapshot.pendingHours,
            bookedHours: snapshot.bookedHours,
            allocatedHours: snapshot.allocatedHours,
          },
        },
      };
    });
  }


  async listCompOffCredits(
    actor: AuthenticatedUser,
    params: ListCompOffParams = {}
  ) {
    const db = this.database.connection;
    const normalizedEmail = params.email?.trim().toLowerCase() || undefined;
    if (params.userId !== undefined) {
      const [targetUser] = await db
        .select({
          id: usersTable.id,
          orgId: usersTable.orgId,
          managerId: usersTable.managerId,
          email: usersTable.email,
        })
        .from(usersTable)
        .where(eq(usersTable.id, params.userId))
        .limit(1);

      if (!targetUser || Number(targetUser.orgId) !== actor.orgId) {
        throw new NotFoundException("User not found in this organisation");
      }

      if (
        normalizedEmail &&
        targetUser.email.trim().toLowerCase() !== normalizedEmail
      ) {
        return {
          user: {
            id: targetUser.id,
            email: targetUser.email,
            managerId:
              targetUser.managerId !== null && targetUser.managerId !== undefined
                ? Number(targetUser.managerId)
                : null,
          },
          credits: [],
        };
      }

      const isSelf = targetUser.id === actor.id;
      if (!isSelf && !this.hasOrgWideCompOffAccess(actor)) {
        if (!this.isReportingManager(actor)) {
          throw new ForbiddenException(
            "You do not have permission to view comp-off credits for this user"
          );
        }

        const canViewTargetUser = this.isDirectReport(targetUser.managerId, actor.id);

        if (!canViewTargetUser) {
          throw new ForbiddenException(
            "Managers can only view comp-off credits for their mentees"
          );
        }
      }

      const rows = await this.fetchCompOffCreditRows(actor.orgId, [targetUser.id], params.status);
      const credits = this.filterCompOffCreditsBySearch(
        await this.mapCreditsToMyCompOffResponse(actor, rows),
        {
          workDate: params.workDate,
          holidayType: params.holidayType,
        }
      );

      return {
        user: {
          id: targetUser.id,
          email: targetUser.email,
          managerId:
            targetUser.managerId !== null && targetUser.managerId !== undefined
              ? Number(targetUser.managerId)
              : null,
        },
        credits,
      };
    }

    const hasOrgWideAccess = this.hasOrgWideCompOffAccess(actor);
    const isManager = this.isReportingManager(actor);

    if (!hasOrgWideAccess && !isManager) {
      throw new ForbiddenException(
        "You do not have permission to view comp-off credits for other users"
      );
    }

    const users = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        managerId: usersTable.managerId,
      })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.orgId, actor.orgId),
          sql`${usersTable.id} <> ${actor.id}`
        )
      );

    if (users.length === 0) {
      return { users: [] };
    }

    let visibleUsers = users;

    if (!hasOrgWideAccess) {
      visibleUsers = users.filter((user) =>
        this.isDirectReport(user.managerId, actor.id)
      );
    }

    if (normalizedEmail) {
      visibleUsers = visibleUsers.filter((user) =>
        user.email.trim().toLowerCase().includes(normalizedEmail)
      );
    }

    if (visibleUsers.length === 0) {
      return { users: [] };
    }

    const userIds = visibleUsers.map((user) => user.id);
    const rows = await this.fetchCompOffCreditRows(actor.orgId, userIds, params.status);

    const rowsByUserId = new Map<number, CompOffCreditListRow[]>();
    for (const row of rows) {
      const existingRows = rowsByUserId.get(row.userId) ?? [];
      existingRows.push(row);
      rowsByUserId.set(row.userId, existingRows);
    }

    const userCredits = await Promise.all(
      visibleUsers.map(async (user) => ({
        user: {
          id: user.id,
          email: user.email,
          managerId:
            user.managerId !== null && user.managerId !== undefined
              ? Number(user.managerId)
              : null,
        },
        credits: await this.mapCreditsToMyCompOffResponse(
          actor,
          rowsByUserId.get(user.id) ?? []
        ),
      }))
    );

    return {
      users: userCredits.map((entry) => ({
        ...entry,
        credits: this.filterCompOffCreditsBySearch(entry.credits, {
          workDate: params.workDate,
          holidayType: params.holidayType,
        }),
      })),
    };
  }

  async listMyCompOffCredits(
    actor: AuthenticatedUser,
    filters?: {
      workDate?: string;
      holidayType?: string;
      status?: ListCompOffParams["status"];
    }
  ): Promise<MyCompOffCreditItem[]> {
    const credits = await this.fetchCompOffCreditRows(actor.orgId, [actor.id]);
    let results = await this.mapCreditsToMyCompOffResponse(actor, credits);

    return this.filterCompOffCreditsBySearch(results, filters ?? {});
  }

  private async fetchCompOffCreditRows(
    orgId: number,
    userIds: number[],
    status?: ListCompOffParams["status"]
  ): Promise<CompOffCreditListRow[]> {
    if (userIds.length === 0) {
      return [];
    }

    const db = this.database.connection;
    const filters = [
      eq(compOffCreditsTable.orgId, orgId),
      inArray(compOffCreditsTable.userId, userIds),
    ];

    if (status) {
      filters.push(eq(compOffCreditsTable.status, status));
    }

    const rows = await db
      .select({
        id: compOffCreditsTable.id,
        userId: compOffCreditsTable.userId,
        workDate: compOffCreditsTable.workDate,
        durationType: compOffCreditsTable.durationType,
        creditedHours: compOffCreditsTable.creditedHours,
        timesheetHours: compOffCreditsTable.timesheetHours,
        status: compOffCreditsTable.status,
        expiresAt: compOffCreditsTable.expiresAt,
        leaveRequestId: compOffCreditsTable.leaveRequestId,
        createdAt: compOffCreditsTable.createdAt,
      })
      .from(compOffCreditsTable)
      .where(and(...filters))
      .orderBy(
        desc(compOffCreditsTable.workDate),
        desc(compOffCreditsTable.createdAt)
      );

    return rows.map((row) => ({
      id: row.id,
      userId: Number(row.userId),
      workDate: row.workDate,
      durationType: row.durationType,
      creditedHours: row.creditedHours,
      timesheetHours: row.timesheetHours,
      status: row.status,
      expiresAt: row.expiresAt,
      leaveRequestId: row.leaveRequestId,
    }));
  }

  private async mapCreditsToMyCompOffResponse(
    actor: AuthenticatedUser,
    credits: CompOffCreditListRow[]
  ): Promise<MyCompOffCreditItem[]> {
    const db = this.database.connection;

    const workDateKeys = Array.from(
      new Set(
        credits.map((credit) =>
          this.formatDateKey(this.normalizeDateUTC(new Date(credit.workDate)))
        )
      )
    );

    const holidayNameByDate = new Map<string, string>();

    if (workDateKeys.length > 0) {
      const holidayRows = await db
        .select({
          date: orgHolidaysTable.date,
          isWorkingDay: orgHolidaysTable.isWorkingDay,
          name: orgHolidaysTable.name,
        })
        .from(orgHolidaysTable)
        .where(
          and(
            eq(orgHolidaysTable.orgId, actor.orgId),
            inArray(orgHolidaysTable.date, workDateKeys)
          )
        );

      for (const holiday of holidayRows) {
        if (!holiday.isWorkingDay && holiday.name) {
          const key = this.formatDateKey(this.normalizeDateUTC(new Date(holiday.date)));
          holidayNameByDate.set(key, holiday.name);
        }
      }
    }

    const leaveRequestIds = credits
      .map((credit) => credit.leaveRequestId)
      .filter((id): id is number => id !== null && id !== undefined);

    const leaveRequestDateById = new Map<number, { startDate: Date; endDate: Date }>();

    if (leaveRequestIds.length > 0) {
      const leaveRows = await db
        .select({
          id: leaveRequestsTable.id,
          startDate: leaveRequestsTable.startDate,
          endDate: leaveRequestsTable.endDate,
        })
        .from(leaveRequestsTable)
        .where(inArray(leaveRequestsTable.id, leaveRequestIds));

      for (const leave of leaveRows) {
        const normalizedStartDate = this.normalizeDateUTC(new Date(leave.startDate));
        const normalizedEndDate = this.normalizeDateUTC(new Date(leave.endDate));
        leaveRequestDateById.set(leave.id, {
          startDate: normalizedStartDate,
          endDate: normalizedEndDate,
        });
      }
    }

    const availedDateByCreditId = new Map<number, Date>();
    const creditsByLeaveRequestId = new Map<number, typeof credits>();

    for (const credit of credits) {
      if (!credit.leaveRequestId) {
        continue;
      }
      const existingCredits = creditsByLeaveRequestId.get(credit.leaveRequestId) ?? [];
      existingCredits.push(credit);
      creditsByLeaveRequestId.set(credit.leaveRequestId, existingCredits);
    }

    for (const [leaveRequestId, linkedCredits] of creditsByLeaveRequestId.entries()) {
      const requestDates = leaveRequestDateById.get(leaveRequestId);
      if (!requestDates) {
        continue;
      }

      const sortedCredits = [...linkedCredits].sort((a, b) => {
        const workDateA = this.normalizeDateUTC(new Date(a.workDate)).getTime();
        const workDateB = this.normalizeDateUTC(new Date(b.workDate)).getTime();
        if (workDateA !== workDateB) {
          return workDateA - workDateB;
        }
        return a.id - b.id;
      });

      const maxOffset = Math.max(
        0,
        Math.floor(
          (requestDates.endDate.getTime() - requestDates.startDate.getTime()) /
            (24 * 60 * 60 * 1000)
        )
      );

      sortedCredits.forEach((credit, index) => {
        const dayOffset = Math.min(index, maxOffset);
        const availedDate = new Date(requestDates.startDate);
        availedDate.setUTCDate(availedDate.getUTCDate() + dayOffset);
        availedDateByCreditId.set(credit.id, availedDate);
      });
    }

    return credits.map((credit) => ({
      workDate: credit.workDate,
      holidayType: this.getHolidayType(
        credit.workDate,
        holidayNameByDate.get(
          this.formatDateKey(this.normalizeDateUTC(new Date(credit.workDate)))
        )
      ),
      duration: credit.durationType,
      timesheetHours: Number(credit.timesheetHours ?? 0),
      creditedHours: Number(credit.creditedHours ?? 0),
      availedDate: availedDateByCreditId.get(credit.id) ?? null,
      expireDate: credit.expiresAt,
      status: credit.status,
    }));
  }

  private filterCompOffCreditsBySearch(
    credits: MyCompOffCreditItem[],
    filters: {
      workDate?: string;
      holidayType?: string;
      status?: ListCompOffParams["status"];
    }
  ): MyCompOffCreditItem[] {
    let results = credits;

    if (filters.workDate) {
      const filterDate = this.formatDateKey(
        this.normalizeDateUTC(new Date(filters.workDate))
      );
      results = results.filter(
        (item) =>
          this.formatDateKey(this.normalizeDateUTC(new Date(item.workDate))) ===
          filterDate
      );
    }

    if (filters.holidayType) {
      const searchType = filters.holidayType.toLowerCase();
      results = results.filter((item) =>
        item.holidayType.toLowerCase().includes(searchType)
      );
    }

    if (filters.status) {
      results = results.filter((item) => item.status === filters.status);
    }

    return results;
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
      checkAdminSelfAction(actor, credit.userId.toString());

      if (credit.status !== "granted" && credit.status !== "pending") {
        throw new BadRequestException(
          "Only pending or active comp-off requests can be revoked"
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

      const isAuthorized = this.canGrantCompOffForUser(actor, targetUser);

      if (!isAuthorized) {
        throw new ForbiddenException(
          "Only administrators can revoke comp-off for any employee, or managers can revoke for their direct reports"
        );
      }

      let leaveTypeId: number | null = null;
      let snapshot: LeaveBalanceSnapshot | null = null;

      if (credit.status === "granted") {
        leaveTypeId = await this.ensureCompOffLeaveType(tx, actor.orgId);
        await this.ensureLeaveBalanceRow(tx, credit.userId, leaveTypeId);

        snapshot = await this.fetchLeaveBalanceSnapshot(
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

      const actorRole = this.getPrivilegedActorRole(actor.roles ?? []);
      if (actorRole) {
        await this.auditService.createLog({
          tx,
          orgId: actor.orgId,
          actorUserId: actor.id,
          actorRole,
          action: 'comp_off_modified',
          subjectType: 'comp_off_modified',
          targetUserId: credit.userId,
          prev: {
            userId: credit.userId,
            status: credit.status,
            creditedHours: Number(credit.creditedHours ?? 0),
            notes: credit.notes ?? null,
          },
          next: {
            status: 'revoked',
            notes: updatedNotes,
          },
        });
      }

      return {
        creditId: credit.id,
        status: "revoked",
        balance:
          leaveTypeId && snapshot
            ? {
                leaveTypeId,
                balanceHours: snapshot.balanceHours,
                pendingHours: snapshot.pendingHours,
                bookedHours: snapshot.bookedHours,
                allocatedHours: snapshot.allocatedHours,
              }
            : null,
      };
    });
  }


  /**
   * Calculate comp off eligibility based on timesheet hours
   * Returns the duration type and credited hours
   */
  private calculateCompOffEligibility(timesheetHours: number): {
    durationType: "half_day" | "full_day" | null;
    creditedHours: number;
  } {
    if (timesheetHours < 3) {
      return {
        durationType: null,
        creditedHours: 0,
      };
    } else if (timesheetHours >= 3 && timesheetHours < 6) {
      return {
        durationType: "half_day",
        creditedHours: COMP_OFF_HALF_DAY_HOURS,
      };
    } else {
      // timesheetHours >= 6
      return {
        durationType: "full_day",
        creditedHours: COMP_OFF_FULL_DAY_HOURS,
      };
    }
  }

  /**
   * Process comp off credit based on off-day work request and timesheet
   * This is called automatically when:
   * 1. Manager creates an off-day work request and timesheet exists
   * 2. Employee fills a timesheet for a date that has an off-day work request
   */
  async processCompOffCredit(
    tx: DatabaseService["connection"],
    requestId: number,
    timesheetId: number,
    timesheetHours: number,
  ): Promise<boolean> {
    const [request] = await tx
      .select({
        id: compOffCreditsTable.id,
        orgId: compOffCreditsTable.orgId,
        userId: compOffCreditsTable.userId,
        workDate: compOffCreditsTable.workDate,
        durationType: compOffCreditsTable.durationType,
        status: compOffCreditsTable.status,
        expiresAt: compOffCreditsTable.expiresAt,
      })
      .from(compOffCreditsTable)
      .where(eq(compOffCreditsTable.id, requestId))
      .limit(1);

    if (!request || request.status !== "pending") {
      return false;
    }

    const workDateKey = this.formatDateKey(this.normalizeDateUTC(new Date(request.workDate)));

    if (new Date(request.expiresAt) < new Date()) {
      return false;
    }

    // Calculate comp off eligibility based on timesheet hours
    const eligibility = this.calculateCompOffEligibility(timesheetHours);

    if (!eligibility.durationType) {
      // Not enough hours to grant comp off
      return false;
    }

    // Fetch already granted comp-off for this date
    const [{ creditedSoFar }] = await tx
      .select({
        creditedSoFar: sql<number>`COALESCE(SUM(${compOffCreditsTable.creditedHours}), 0)`,
      })
      .from(compOffCreditsTable)
      .where(
        and(
          eq(compOffCreditsTable.orgId, request.orgId),
          eq(compOffCreditsTable.userId, request.userId),
          eq(compOffCreditsTable.workDate, sql`CAST(${workDateKey} AS date)`),
          eq(compOffCreditsTable.status, "granted")
        )
      );

    const alreadyGrantedHours = Number(creditedSoFar ?? 0);
    const eligibilityHours = Number(eligibility.creditedHours ?? 0);
    const remainingEligibilityHours = eligibilityHours - alreadyGrantedHours;

    if (remainingEligibilityHours <= HOURS_NEGATIVE_TOLERANCE) {
      return false;
    }

    // Final grant = MIN(manager permission, remaining eligibility)
    const managerPermissionHours =
      request.durationType === "half_day"
        ? COMP_OFF_HALF_DAY_HOURS
        : COMP_OFF_FULL_DAY_HOURS;

    const finalCreditedHours = Math.min(
      managerPermissionHours,
      remainingEligibilityHours
    );

    if (finalCreditedHours <= HOURS_NEGATIVE_TOLERANCE) {
      return false;
    }

    const leaveTypeId = await this.ensureCompOffLeaveType(tx, request.orgId);
    await this.ensureLeaveBalanceRow(tx, request.userId, leaveTypeId);

    let snapshot = await this.fetchLeaveBalanceSnapshot(tx, request.userId, leaveTypeId);

    snapshot = await this.updateLeaveBalanceFromSnapshot(tx, snapshot, {
      balanceHours: finalCreditedHours,
      allocatedHours: finalCreditedHours,
    });

    const now = new Date();
    const grantExpiresAt = this.calculateCompOffExpiryAt(
      request.workDate as unknown as string | Date
    );

    await tx
      .update(compOffCreditsTable)
      .set({
        timesheetId,
        creditedHours: finalCreditedHours.toFixed(2),
        timesheetHours: timesheetHours.toFixed(2),
        status: "granted",
        expiresAt: grantExpiresAt,
        updatedAt: now,
      })
      .where(eq(compOffCreditsTable.id, request.id));

    return true;
  }

  /**
   * Expire pending comp-off requests once their configured expiry date passes
   * and no eligible timesheet has been filed.
   */
  private async expireStalePendingCompOffRequests(
    tx: DatabaseService["connection"],
    orgId: number,
    userId: number,
    now: Date
  ) {
    const staleRequests = await tx
      .select({ id: compOffCreditsTable.id })
      .from(compOffCreditsTable)
      .where(
        and(
          eq(compOffCreditsTable.orgId, orgId),
          eq(compOffCreditsTable.userId, userId),
          eq(compOffCreditsTable.status, "pending"),
          lt(compOffCreditsTable.expiresAt, now)
        )
      );

    if (staleRequests.length > 0) {
      const staleRequestIds = staleRequests.map((r) => r.id);
      await tx
        .update(compOffCreditsTable)
        .set({
          status: "expired",
          notes: "Expired because no eligible timesheet was filed before the comp-off expiry date.",
          updatedAt: now,
        })
        .where(inArray(compOffCreditsTable.id, staleRequestIds));
    }
  }

  /**
   * Public method to trigger comp off processing for a specific date
   * Can be called by timesheet service when a timesheet is created/updated
   */
  async tryProcessCompOffForTimesheet(
    orgId: number,
    userId: number,
    workDate: Date,
    timesheetId: number,
    timesheetHours: number
  ): Promise<boolean> {
    const db = this.database.connection;
    const workDateKey = this.formatDateKey(workDate);

    return db.transaction(async (tx) => {
      await this.expireStalePendingCompOffRequests(tx, orgId, userId, new Date());

      const eligibility = this.calculateCompOffEligibility(timesheetHours);
      const eligibilityHours = Number(eligibility.creditedHours ?? 0);

      // If timesheet hours are insufficient, revert any granted comp-off for this date.
      if (eligibilityHours < HOURS_NEGATIVE_TOLERANCE) {
        const grantedCredits = await tx
          .select({ id: compOffCreditsTable.id })
          .from(compOffCreditsTable)
          .where(
            and(
              eq(compOffCreditsTable.orgId, orgId),
              eq(compOffCreditsTable.userId, userId),
              or(
                eq(compOffCreditsTable.workDate, sql`CAST(${workDateKey} AS date)`),
                eq(compOffCreditsTable.timesheetId, timesheetId),
              ),
              eq(compOffCreditsTable.status, "granted")
            )
          );

        if (grantedCredits.length > 0) {
          const leaveTypeId = await this.ensureCompOffLeaveType(tx, orgId);
          for (const credit of grantedCredits) {
            await this.revertCompOffCredit(tx, credit.id, leaveTypeId, userId);
          }
          return true; // Reverted successfully
        }
        return false; // Nothing to revert
      }

      // Process pending comp-off request(s) for this user/date
      const pendingRequests = await tx
        .select({
          id: compOffCreditsTable.id,
        })
        .from(compOffCreditsTable)
        .where(
          and(
            eq(compOffCreditsTable.orgId, orgId),
            eq(compOffCreditsTable.userId, userId),
            or(
              eq(compOffCreditsTable.workDate, sql`CAST(${workDateKey} AS date)`),
              eq(compOffCreditsTable.timesheetId, timesheetId),
            ),
            eq(compOffCreditsTable.status, "pending")
          )
        );

      let processed = false;
      for (const pendingRequest of pendingRequests) {
        const granted = await this.processCompOffCredit(
          tx,
          pendingRequest.id,
          timesheetId,
          timesheetHours,
        );
        processed = processed || granted;
      }

      // Reconcile already granted credits for this work date when timesheet hours increase.
      // This prevents stale comp-off values after admin edits to timesheet entries.
      if (eligibilityHours > HOURS_NEGATIVE_TOLERANCE) {
        const grantedCredits = await tx
          .select({
            id: compOffCreditsTable.id,
            durationType: compOffCreditsTable.durationType,
            creditedHours: compOffCreditsTable.creditedHours,
          })
          .from(compOffCreditsTable)
          .where(
            and(
              eq(compOffCreditsTable.orgId, orgId),
              eq(compOffCreditsTable.userId, userId),
              or(
                eq(compOffCreditsTable.workDate, sql`CAST(${workDateKey} AS date)`),
                eq(compOffCreditsTable.timesheetId, timesheetId),
              ),
              eq(compOffCreditsTable.status, "granted")
            )
          )
          .orderBy(compOffCreditsTable.createdAt, compOffCreditsTable.id);

        const totalGranted = grantedCredits.reduce(
          (sum, credit) => sum + Number(credit.creditedHours ?? 0),
          0,
        );

        let remainingEligibility = this.normalizeHours(eligibilityHours - totalGranted);

        if (remainingEligibility > HOURS_NEGATIVE_TOLERANCE && grantedCredits.length > 0) {
          const leaveTypeId = await this.ensureCompOffLeaveType(tx, orgId);
          await this.ensureLeaveBalanceRow(tx, userId, leaveTypeId);

          const now = new Date();

          let snapshot = await this.fetchLeaveBalanceSnapshot(tx, userId, leaveTypeId);

          for (const credit of grantedCredits) {
            if (remainingEligibility <= HOURS_NEGATIVE_TOLERANCE) {
              break;
            }

            const currentCredited = Number(credit.creditedHours ?? 0);
            // Reconcile to current earned eligibility (not only initial requested duration),
            // so increasing timesheet hours can upgrade 4h comp-off to 8h.
            const requestedCap =
              eligibility.durationType === "full_day"
                ? COMP_OFF_FULL_DAY_HOURS
                : credit.durationType === "full_day"
                  ? COMP_OFF_FULL_DAY_HOURS
                  : COMP_OFF_HALF_DAY_HOURS;
            const additionalAllowed = this.normalizeHours(requestedCap - currentCredited);

            if (additionalAllowed <= HOURS_NEGATIVE_TOLERANCE) {
              continue;
            }

            const additionalHours = Math.min(additionalAllowed, remainingEligibility);
            if (additionalHours <= HOURS_NEGATIVE_TOLERANCE) {
              continue;
            }

            const nextCredited = this.normalizeHours(currentCredited + additionalHours);

            await tx
              .update(compOffCreditsTable)
              .set({
                timesheetId,
                durationType:
                  nextCredited >= COMP_OFF_FULL_DAY_HOURS - HOURS_NEGATIVE_TOLERANCE
                    ? "full_day"
                    : credit.durationType,
                creditedHours: nextCredited.toFixed(2),
                timesheetHours: timesheetHours.toFixed(2),
                updatedAt: now,
              })
              .where(eq(compOffCreditsTable.id, credit.id));

            snapshot = await this.updateLeaveBalanceFromSnapshot(tx, snapshot, {
              balanceHours: additionalHours,
              allocatedHours: additionalHours,
            });

            remainingEligibility = this.normalizeHours(remainingEligibility - additionalHours);
            processed = true;
          }
        }
      }

      return processed;
    });
  }

  async reviewLeaveRequest(
    requestId: number,
    action: "approve" | "reject",
    payload: ReviewLeaveRequestDto,
    approver: AuthenticatedUser
  ) {
    const db = this.database.connection;
    return await db.transaction(async (tx) => {
      const [request] = await tx
        .select({
          id: leaveRequestsTable.id,
          orgId: leaveRequestsTable.orgId,
          state: leaveRequestsTable.state,
          userId: leaveRequestsTable.userId,
          startDate: leaveRequestsTable.startDate,
          endDate: leaveRequestsTable.endDate,
          hours: leaveRequestsTable.hours,
          managerId: usersTable.managerId,
          leaveTypeId: leaveRequestsTable.leaveTypeId,
          leaveTypePaid: leaveTypesTable.paid,
          leaveTypeCode: leaveTypesTable.code,
          leaveTypeName: leaveTypesTable.name,
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

      if (!approver) {
        throw new ForbiddenException(
          "You are not authorized to review this leave request"
        );
      }
      checkAdminSelfAction(approver, request.userId.toString());
      // Prevent users from approving/rejecting their own leave requests
      if (request.userId === approver.id) {
        throw new ForbiddenException(
          "You cannot approve or reject your own leave request"
        );
      }

      // Get approver's roles
      const approverRoles = await tx
        .select({ roleKey: rolesTable.key })
        .from(userRoles)
        .innerJoin(rolesTable, eq(userRoles.roleId, rolesTable.id))
        .where(eq(userRoles.userId, approver.id));

      const roleKeys = approverRoles.map((r) => r.roleKey);
      const isAdmin = roleKeys.includes("admin");
      const isSuperAdmin = roleKeys.includes("super_admin");
      const isManager = roleKeys.includes("manager");
      const actorRole = isSuperAdmin
        ? 'super_admin'
        : isAdmin
        ? 'admin'
        : null;

      // Admin and super_admin can approve any request (except their own)
      if (!isAdmin && !isSuperAdmin) {
        const isAuthorized = await this.isManagerInHierarchy(
          tx,
          request.userId,
          approver.id,
        );

        if (!isAuthorized) {
          throw new ForbiddenException(
            "You are not in the reporting chain for this employee",
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
          decidedByUserId: approver.id,
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
      
      // Check if this is an LWP leave type
      const isLWP = request.leaveTypeCode === LWP_LEAVE_CODE || 
                    (request.leaveTypeName?.toLowerCase().includes('without pay') ?? false);
      
      // Handle balance adjustments for paid leaves and LWP
      const shouldAdjustBalance = isPaidLeave || isLWP;

      if (shouldAdjustBalance) {
        if (action === "approve") {
          if (request.leaveTypeCode === COMP_OFF_LEAVE_CODE) {
            await this.consumeCompOffCredits(
              tx,
              request.userId,
              requestedHours,
              request.id,
            );
          }
          await this.adjustLeaveBalance(tx, request.userId, request.leaveTypeId, {
            pendingHours: -requestedHours,
            bookedHours: requestedHours,
          });
        } else if (previousState === "pending") {
          await this.adjustLeaveBalance(tx, request.userId, request.leaveTypeId, {
            pendingHours: -requestedHours,
            balanceHours: requestedHours,
          });
          if (request.leaveTypeCode === COMP_OFF_LEAVE_CODE) {
            await this.clearCompOffCreditLinks(tx, request.id);
          }
        } else if (previousState === "approved") {
          await this.adjustLeaveBalance(tx, request.userId, request.leaveTypeId, {
            bookedHours: -requestedHours,
            balanceHours: requestedHours,
          });
        }
      }

      if (
        action === "reject" &&
        request.leaveTypeCode === COMP_OFF_LEAVE_CODE
      ) {
        await this.clearCompOffCreditLinks(tx, request.id);
      }

      if (actorRole) {
        await this.auditService.createLog({
          tx,
          orgId: request.orgId,
          actorUserId: approver.id,
          actorRole,
          action: 'leave_modified',
          subjectType: 'leave_modified',
          targetUserId: request.userId,
          prev: {
            state: previousState,
          },
          next: {
            state: newState,
            comment: payload.comment ?? null,
          },
        });
      }

      const affectedCycles = this.getCycleRangesForDateWindow(
        new Date(request.startDate),
        new Date(request.endDate),
      );
      for (const cycle of affectedCycles) {
        await this.recalculateAndPersistPayableDaysForCycle(
          tx,
          request.orgId,
          request.userId,
          cycle.cycleStart,
          cycle.cycleEnd,
          cycle.cycleKey,
          now,
        );
      }

      return updated;
    });
  }
  async bulkReviewLeaveRequests(
    payload: BulkReviewLeaveIdsDto,
    action: "approve" | "reject",
    approver: AuthenticatedUser
  ) {
    const hasExplicitIds = payload.requestIds && payload.requestIds.length > 0;
    const hasRange = payload.month !== undefined && payload.year !== undefined;
    if (!hasExplicitIds && !hasRange) {
      throw new BadRequestException(
        "Provide requestIds or both month and year for bulk review."
      );
    }

    const db = this.database.connection;

    return await db.transaction(async (tx) => {
      if (!approver) {
        throw new ForbiddenException(
          "You are not authorized to review these leave requests"
        );
      }

      const [approverUser] = await tx
        .select({
          id: usersTable.id,
          role: usersTable.rolePrimary,
        })
        .from(usersTable)
        .where(eq(usersTable.id, approver.id))
        .limit(1);

      if (!approverUser) {
        throw new ForbiddenException(
          "You are not authorized to review these leave requests"
        );
      }

      // Get approver's roles
      const approverRoles = await tx
        .select({ roleKey: rolesTable.key })
        .from(userRoles)
        .innerJoin(rolesTable, eq(userRoles.roleId, rolesTable.id))
        .where(eq(userRoles.userId, approver.id));

      const roleKeys = approverRoles.map((r) => r.roleKey);
      const isAdmin = roleKeys.includes("admin");
      const isSuperAdmin = roleKeys.includes("super_admin");
      const isManager = roleKeys.includes("manager");
      const actorRole = isSuperAdmin
        ? 'super_admin'
        : isAdmin
        ? 'admin'
        : null;

      // Check if user has any authorization role
      if (!isAdmin && !isSuperAdmin && !isManager) {
        throw new ForbiddenException(
          "You do not have permission to review leave requests"
        );
      }

      const filters = [];
      let evaluatedIds: number[] | undefined;

      if (payload.requestIds?.length) {
        evaluatedIds = Array.from(new Set(payload.requestIds));
        filters.push(inArray(leaveRequestsTable.id, evaluatedIds));
      } else if (hasRange) {
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
          orgId: leaveRequestsTable.orgId,
          userId: leaveRequestsTable.userId,
          startDate: leaveRequestsTable.startDate,
          endDate: leaveRequestsTable.endDate,
          state: leaveRequestsTable.state,
          hours: leaveRequestsTable.hours,
          managerId: usersTable.managerId,
          leaveTypeId: leaveRequestsTable.leaveTypeId,
          leaveTypePaid: leaveTypesTable.paid,
          leaveTypeCode: leaveTypesTable.code,
          leaveTypeName: leaveTypesTable.name,
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

      const managedCandidates = candidates.filter((candidate) => {
        checkAdminSelfAction(approver, candidate.userId.toString());
        // Always exclude user's own leave requests
        if (candidate.userId === approver.id) {
          return false;
        }

        // Admin and super_admin can approve any request (except their own)
        if (isAdmin || isSuperAdmin) {
          return true;
        }

        // Manager can only approve requests from their direct reports
        if (isManager && candidate.managerId === approver.id) {
          return true;
        }

        // Otherwise, not authorized
        return false;
      });

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
          decidedByUserId: approver.id,
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
          const isLWP = request.leaveTypeCode === LWP_LEAVE_CODE || 
                        (request.leaveTypeName?.toLowerCase().includes('without pay') ?? false);
          const shouldAdjustBalance = isPaidLeave || isLWP;
          
          if (!shouldAdjustBalance) {
            continue;
          }
          const hours = Number(request.hours ?? 0);
          await this.ensureLeaveBalanceRow(
            tx,
            request.userId,
            request.leaveTypeId
          );
          await this.adjustLeaveBalance(tx, request.userId, request.leaveTypeId, {
            pendingHours: -hours,
            bookedHours: hours,
          });
        }
      } else {
        for (const request of eligible) {
          const isPaidLeave = request.leaveTypePaid ?? true;
          const isLWP = request.leaveTypeCode === LWP_LEAVE_CODE || 
                        (request.leaveTypeName?.toLowerCase().includes('without pay') ?? false);
          const shouldAdjustBalance = isPaidLeave || isLWP;
          
          if (!shouldAdjustBalance) {
            continue;
          }

          const hours = Number(request.hours ?? 0);
          if (request.state === "approved") {
            await this.ensureLeaveBalanceRow(
              tx,
              request.userId,
              request.leaveTypeId
            );
            await this.adjustLeaveBalance(tx, request.userId, request.leaveTypeId, {
              bookedHours: -hours,
              balanceHours: hours,
            });
          } else if (request.state === "pending") {
            await this.ensureLeaveBalanceRow(
              tx,
              request.userId,
              request.leaveTypeId
            );
            await this.adjustLeaveBalance(tx, request.userId, request.leaveTypeId, {
              pendingHours: -hours,
              balanceHours: hours,
            });
          }
        }
      }

      if (actorRole) {
        for (const request of eligible) {
          await this.auditService.createLog({
            tx,
            orgId: request.orgId,
            actorUserId: approver.id,
            actorRole,
            action: 'leave_modified',
            subjectType: 'leave_modified',
            targetUserId: request.userId,
            prev: {
              state: request.state,
            },
            next: {
              state: newState,
              comment: payload.comment ?? null,
            },
          });
        }
      }

      const cycleRecalcKeys = new Set<string>();
      for (const request of eligible) {
        const cycles = this.getCycleRangesForDateWindow(
          new Date(request.startDate),
          new Date(request.endDate),
        );
        for (const cycle of cycles) {
          const key = `${request.orgId}:${request.userId}:${cycle.cycleKey}`;
          if (!cycleRecalcKeys.has(key)) {
            cycleRecalcKeys.add(key);
            await this.recalculateAndPersistPayableDaysForCycle(
              tx,
              request.orgId,
              request.userId,
              cycle.cycleStart,
              cycle.cycleEnd,
              cycle.cycleKey,
              now,
            );
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

  private getPrivilegedActorRole(roles: string[]): 'super_admin' | 'admin' | null {
    if (roles.includes('super_admin')) {
      return 'super_admin';
    }
    if (roles.includes('admin')) {
      return 'admin';
    }
    return null;
  }

  private isAdminOrSuperAdmin(actor?: AuthenticatedUser): boolean {
    if (!actor) {
      return false;
    }

    const privilegedRoles = new Set(["admin", "super_admin", "superadmin"]);
    return (actor.roles ?? []).some((role) => privilegedRoles.has(role));
  }

  private enforcePastDateWindowForNonPrivilegedActor(
    startDate: Date,
    endDate: Date,
    actor?: AuthenticatedUser,
  ) {
    if (this.isAdminOrSuperAdmin(actor)) {
      return;
    }

    const today = this.normalizeDateUTC(new Date());
    const normalizedStartDate = this.normalizeDateUTC(startDate);
    const normalizedEndDate = this.normalizeDateUTC(endDate);

    if (normalizedStartDate >= today && normalizedEndDate >= today) {
      return;
    }

    const currentCycle = SalaryCycleUtil.getCurrentSalaryCycle(new Date());
    const cycleStart = this.normalizeDateUTC(currentCycle.start);
    const cycleEnd = this.normalizeDateUTC(currentCycle.end);

    if (normalizedStartDate < cycleStart || normalizedEndDate < cycleStart) {
      throw new BadRequestException(
        `Leave requests for past dates are only allowed within the current salary cycle (${currentCycle.cycleLabel})`
      );
    }

    if (normalizedStartDate >= cycleEnd || normalizedEndDate >= cycleEnd) {
      throw new BadRequestException(
        `Leave requests for past dates are only allowed within the current salary cycle (${currentCycle.cycleLabel})`
      );
    }
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
      if (this.isFixedHoliday(cursor)) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        continue;
      }
      const dayInfo = await this.calendarService.getDayInfo(orgId, cursor);
      if (!dayInfo.isWorkingDay) {
        throw new BadRequestException(
          `Cannot request leave on non-working day ${cursor
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

    let workingDays = 0;
    const cursor = new Date(start);
    while (cursor <= finish) {
      const isNonWorking = await this.isNonWorkingDay(orgId, cursor);
      if (!isNonWorking) {
        workingDays += 1;
      }

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return {
      workingDays,
      totalHours: workingDays * HOURS_PER_WORKING_DAY,
    };
  }

  private async hasBlockingTimesheet(
    orgId: number,
    userId: number,
    startDate: Date,
    endDate: Date,
    requestedDurationType: "half_day" | "full_day" | "custom"
  ): Promise<boolean> {
    // Half-day leave can coexist with timesheets (other half worked).
    if (requestedDurationType === "half_day") {
      return false;
    }

    const db = this.database.connection;
    const start = this.normalizeDateUTC(startDate);
    const end = this.normalizeDateUTC(endDate);

    const rows = await db
      .select({ id: timesheetsTable.id })
      .from(timesheetsTable)
      .where(
        and(
          eq(timesheetsTable.orgId, orgId),
          eq(timesheetsTable.userId, userId),
          gte(timesheetsTable.workDate, start),
          lte(timesheetsTable.workDate, end)
        )
      )
      .limit(1);

    return rows.length > 0;
  }

  private normalizeHours(value: number): number {
    const rounded = Math.round(value * 100) / 100;
    return Math.abs(rounded) < HOURS_NEGATIVE_TOLERANCE ? 0 : rounded;
  }

  private isFixedHoliday(date: Date): boolean {
    const mmdd = `${(date.getUTCMonth() + 1).toString().padStart(2, "0")}-${date
      .getUTCDate()
      .toString()
      .padStart(2, "0")}`;
    return mmdd === "01-26" || mmdd === "08-15" || mmdd === "10-02" || mmdd === "12-31";
  }

  private async isNonWorkingDay(orgId: number, date: Date): Promise<boolean> {
    if (this.isFixedHoliday(date)) {
      return true;
    }

    const dayOfWeek = date.getUTCDay();
    if (dayOfWeek === 0) {
      return true;
    }

    if (dayOfWeek === 6 && this.isSecondOrFourthSaturday(date)) {
      return true;
    }

    const info = await this.calendarService.getDayInfo(orgId, date);
    return !info.isWorkingDay || info.isHoliday;
  }

  private async notifyLatestProjectSlackChannel(
    userId: number,
    orgId: number,
    payload: Record<string, unknown>
  ) {
    const db = this.database.connection;
    
    // Get recent projects from employee's timesheet entries
    const projects = await db
      .select({
        projectId: projectsTable.id,
        projectName: projectsTable.name,
        workDate: timesheetsTable.workDate,
        slackChannelId: projectsTable.slackChannelId,
        discordChannelId: projectsTable.discordChannelId,
        projectManagerName: usersTable.name,
        projectManagerSlackId: usersTable.slackId,
        projectManagerDiscordId: usersTable.discordId,
      })
      .from(timesheetsTable)
      .innerJoin(
        timesheetEntriesTable,
        eq(timesheetsTable.id, timesheetEntriesTable.timesheetId),
      )
      .innerJoin(
        projectsTable,
        eq(timesheetEntriesTable.projectId, projectsTable.id),
      )
      .innerJoin(
        usersTable,
        eq(projectsTable.projectManagerId, usersTable.id),
      )
      .where(
        and(
          eq(timesheetsTable.userId, userId),
          eq(timesheetsTable.orgId, orgId),
          or(
            isNotNull(projectsTable.slackChannelId),
            isNotNull(projectsTable.discordChannelId)
          ),
        ),
      )
      .orderBy(desc(timesheetsTable.workDate))
      .limit(50); // Get enough projects to filter through weekends

    if (projects.length === 0) {
      return;
    }

    // Find the last valid working DATE (skip weekends, holidays)
    let lastValidWorkDate: Date | null = null;
    for (const project of projects) {
      const workDate = new Date(project.workDate);
      const dayOfWeek = workDate.getUTCDay(); // 0 = Sunday, 6 = Saturday
      
      // Skip Saturday (6) and Sunday (0)
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        continue;
      }
      
      // Check if it's a holiday or festival leave day
      const dayInfo = await this.calendarService.getDayInfo(orgId, workDate);
      if (dayInfo.isHoliday) {
        continue; // Skip festival/holiday days
      }
      
      // Found the last valid working date
      lastValidWorkDate = workDate;
      break;
    }

    if (!lastValidWorkDate) {
      return; // No valid working date found
    }

    // Get ALL projects from that last valid working day (excluding filtered projects)
    const validProjects = projects.filter(project => {
      const workDate = new Date(project.workDate);
      
      // Must be from the last valid working date
      if (workDate.getTime() !== lastValidWorkDate.getTime()) {
        return false;
      }
      
      // Skip Learning Saturday project
      if (project.projectName && project.projectName.toLowerCase().includes('Learning Saturdays')) {
        return false;
      }
      
      return true;
    });

    if (validProjects.length === 0) {
      return; // No valid projects found
    }

    // Deduplicate by projectId
    const uniqueProjects = Array.from(
      new Map(validProjects.map(p => [p.projectId, p])).values()
    );

    // Send notifications to ALL projects from the last valid working day
    for (const project of uniqueProjects) {
      // Enhance payload with project manager information
      const enhancedPayload = {
        ...payload,
        projectId: project.projectId,
        projectName: project.projectName,
        projectManagerName: project.projectManagerName,
        projectManagerSlackId: project.projectManagerSlackId,
        projectManagerDiscordId: project.projectManagerDiscordId,
      };

      // Send Slack notification if configured
      if (project.slackChannelId) {
        await db.insert(notificationsTable).values({
          orgId,
          channel: "slack",
          toRef: { channelId: project.slackChannelId },
          template: "leave_request",
          payload: enhancedPayload,
          state: "pending",
        });
      }

      // Send Discord notification if configured
      if (project.discordChannelId) {
        await db.insert(notificationsTable).values({
          orgId,
          channel: "discord",
          toRef: { webhookUrl: project.discordChannelId },
          template: "leave_request",
          payload: enhancedPayload,
          state: "pending",
        });
      }
    }
  }

  private hasOrgWideCompOffAccess(actor: AuthenticatedUser): boolean {
    const privilegedRoles = new Set(["admin", "super_admin", "superadmin"]);
    return (actor.roles ?? []).some((role) => privilegedRoles.has(role));
  }

  private hasOrgWideLeaveBalanceAccess(actor: AuthenticatedUser): boolean {
    const privilegedRoles = new Set(["admin", "super_admin", "superadmin"]);
    return (actor.roles ?? []).some((role) => privilegedRoles.has(role));
  }

  private isDirectReport(
    managerId: number | null | undefined,
    actorId: number
  ): boolean {
    return (
      managerId !== null &&
      managerId !== undefined &&
      Number(managerId) === actorId
    );
  }

  private isReportingManager(actor: AuthenticatedUser): boolean {
    const managerRoles = new Set(["manager", "reporting_manager"]);
    return (actor.roles ?? []).some((role) => managerRoles.has(role));
  }

  private canGrantCompOffForUser(
    actor: AuthenticatedUser,
    targetUser: { managerId: number | null | undefined }
  ): boolean {
    // Admin/SuperAdmin can grant for all employees
    if (this.hasOrgWideCompOffAccess(actor)) {
      return true;
    }
    // Managers can grant only for their mentees (direct reports)
    if (
      targetUser.managerId !== null &&
      targetUser.managerId !== undefined &&
      Number(targetUser.managerId) === actor.id
    ) {
      return true;
    }
    return false;
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

  private async expireGrantedCompOffForUserIfNeeded(
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
        availedHours: compOffCreditsTable.availedHours,
        status: compOffCreditsTable.status,
      })
      .from(compOffCreditsTable)
      .where(
        and(
          eq(compOffCreditsTable.orgId, orgId),
          eq(compOffCreditsTable.userId, userId),
          inArray(compOffCreditsTable.status, ["granted", "partial_availed"]),
          isNull(compOffCreditsTable.leaveRequestId),
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
      const creditedHours = Number(credit.creditedHours ?? 0);
      const availedHours = Number(credit.availedHours ?? 0);
      const remainingHours = Math.max(0, creditedHours - availedHours);

      if (remainingHours > 0 && snapshot.balanceHours > 0) {
        const deduction = Math.min(snapshot.balanceHours, remainingHours);
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

  private calculateCompOffExpiryAt(workDate: Date | string): Date {
    const expiry = new Date(workDate);
    expiry.setUTCDate(expiry.getUTCDate() + COMP_OFF_EXPIRY_DAYS);
    // Expire at the end of the expiry date, not at the start.
    expiry.setUTCHours(23, 59, 59, 999);
    return expiry;
  }

  private formatDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private getWeekdayName(workDate: string | Date): string {
    const date = this.normalizeDateUTC(new Date(workDate));
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "UTC",
    });
  }

  private getHolidayType(workDate: string | Date, holidayName?: string): string {
    if (holidayName) {
      return holidayName;
    }

    const date = this.normalizeDateUTC(new Date(workDate));
    const dayOfWeek = date.getUTCDay();

    if (dayOfWeek === 0) {
      return "Sunday";
    }

    if (dayOfWeek === 6) {
      const occurrence = Math.ceil(date.getUTCDate() / 7);
      if (occurrence === 2) {
        return "2nd Saturday";
      }
      if (occurrence === 4) {
        return "4th Saturday";
      }
      return "Saturday";
    }

    return this.getWeekdayName(date).toLowerCase();
  }

  private getPayableDaysForTimesheetHours(hours: number): number {
    if (hours < 3) {
      return 0;
    }
    if (hours < 6) {
      return 0.5;
    }
    return 1;
  }

  private getCycleRangeForWorkDate(workDate: Date): {
    cycleStart: Date;
    cycleEnd: Date;
    cycleKey: string;
  } {
    const normalizedWorkDate = this.normalizeDateUTC(workDate);
    const day = normalizedWorkDate.getUTCDate();
    const year = normalizedWorkDate.getUTCFullYear();
    const month = normalizedWorkDate.getUTCMonth();

    let cycleStart: Date;
    let cycleEnd: Date;

    if (day >= 26) {
      cycleStart = new Date(Date.UTC(year, month, 26));
      cycleEnd = new Date(Date.UTC(year, month + 1, 25));
    } else {
      cycleStart = new Date(Date.UTC(year, month - 1, 26));
      cycleEnd = new Date(Date.UTC(year, month, 25));
    }

    return {
      cycleStart,
      cycleEnd,
      cycleKey: this.formatDateKey(cycleEnd),
    };
  }

  private getCycleRangesForDateWindow(
    startDate: Date,
    endDate: Date,
  ): Array<{ cycleStart: Date; cycleEnd: Date; cycleKey: string }> {
    const start = this.normalizeDateUTC(startDate);
    const end = this.normalizeDateUTC(endDate);
    const ranges = new Map<string, { cycleStart: Date; cycleEnd: Date; cycleKey: string }>();

    const cursor = new Date(start);
    while (cursor <= end) {
      const range = this.getCycleRangeForWorkDate(cursor);
      ranges.set(range.cycleKey, range);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return Array.from(ranges.values());
  }

  private async recalculateAndPersistPayableDaysForCycle(
    tx: DatabaseService['connection'],
    orgId: number,
    userId: number,
    cycleStart: Date,
    cycleEnd: Date,
    cycleKey: string,
    now: Date,
  ): Promise<void> {
    const cycleStartDate = this.normalizeDateUTC(cycleStart);
    const cycleEndDate = this.normalizeDateUTC(cycleEnd);

    const [userEmployment] = await tx
      .select({
        dateOfJoining: usersTable.dateOfJoining,
        dateOfExit: usersTable.dateOfExit,
      })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.id, userId),
          eq(usersTable.orgId, orgId),
        ),
      )
      .limit(1);

    const holidayMap = await this.calendarService.getHolidayMap(
      orgId,
      cycleStartDate,
      cycleEndDate,
    );

    const workingDayKeys = new Set<string>();
    const dayCursor = new Date(cycleStartDate);
    while (dayCursor <= cycleEndDate) {
      const key = this.formatDateKey(dayCursor);
      const dayOfWeek = dayCursor.getUTCDay();
      const isSunday = dayOfWeek === 0;
      const isSaturday = dayOfWeek === 6;
      const isSecondFourthSaturday =
        isSaturday && this.isSecondOrFourthSaturday(dayCursor);
      const defaultWorking = !(isSunday || isSecondFourthSaturday);
      const override = holidayMap.get(key);
      const isWorkingDay = override ? override.isWorkingDay : defaultWorking;

      if (isWorkingDay) {
        workingDayKeys.add(key);
      }

      dayCursor.setUTCDate(dayCursor.getUTCDate() + 1);
    }

    const cycleTimesheets = await tx
      .select({
        workDate: timesheetsTable.workDate,
        totalHours: timesheetsTable.totalHours,
      })
      .from(timesheetsTable)
      .where(
        and(
          eq(timesheetsTable.orgId, orgId),
          eq(timesheetsTable.userId, userId),
          gte(timesheetsTable.workDate, cycleStartDate),
          lte(timesheetsTable.workDate, cycleEndDate),
        ),
      );

    let totalHours = 0;
    let totalWorkingDays = 0;

    for (const timesheet of cycleTimesheets) {
      const workDateKey = this.formatDateKey(this.normalizeDateUTC(new Date(timesheet.workDate)));
      if (!workingDayKeys.has(workDateKey)) {
        continue;
      }

      const hours = Number(timesheet.totalHours ?? 0);
      if (!Number.isFinite(hours)) {
        continue;
      }
      totalHours += hours;
      totalWorkingDays += this.getPayableDaysForTimesheetHours(hours);
    }

    const approvedLeaves = await tx
      .select({
        startDate: leaveRequestsTable.startDate,
        endDate: leaveRequestsTable.endDate,
        durationType: leaveRequestsTable.durationType,
        leaveTypeCode: leaveTypesTable.code,
        leaveTypeName: leaveTypesTable.name,
      })
      .from(leaveRequestsTable)
      .innerJoin(
        leaveTypesTable,
        eq(leaveRequestsTable.leaveTypeId, leaveTypesTable.id),
      )
      .where(
        and(
          eq(leaveRequestsTable.userId, userId),
          eq(leaveRequestsTable.state, 'approved'),
          lte(leaveRequestsTable.startDate, cycleEndDate),
          gte(leaveRequestsTable.endDate, cycleStartDate),
        ),
      );

    const joiningDate = userEmployment?.dateOfJoining
      ? this.normalizeDateUTC(new Date(userEmployment.dateOfJoining))
      : null;
    const exitDate = userEmployment?.dateOfExit
      ? this.normalizeDateUTC(new Date(userEmployment.dateOfExit))
      : null;

    const effectiveStartDate = joiningDate && joiningDate > cycleStartDate
      ? joiningDate
      : cycleStartDate;
    const effectiveEndDate = joiningDate === null
      ? cycleEndDate
      : exitDate && exitDate < cycleEndDate
        ? exitDate
        : cycleEndDate;

    const expectedAttendance =
      effectiveEndDate >= effectiveStartDate
        ? Math.floor(
            (effectiveEndDate.getTime() - effectiveStartDate.getTime()) /
              (24 * 60 * 60 * 1000),
          ) + 1
        : 0;

    let weekOffDays = 0;
    if (effectiveEndDate >= effectiveStartDate) {
      const cursor = new Date(effectiveStartDate);
      while (cursor <= effectiveEndDate) {
        const key = this.formatDateKey(cursor);
        if (!workingDayKeys.has(key)) {
          weekOffDays += 1;
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    let totalPayableDaysFromLeaves = 0;
    for (const leave of approvedLeaves) {
      const leaveTypeCode = (leave.leaveTypeCode ?? '').toLowerCase();
      const leaveTypeName = (leave.leaveTypeName ?? '').toLowerCase();
      const isLwp =
        leaveTypeCode === 'lwp' ||
        leaveTypeName.includes('without pay') ||
        leaveTypeName.includes('lwp');
      if (isLwp) {
        continue;
      }

      const leaveStart = this.normalizeDateUTC(new Date(leave.startDate));
      const leaveEnd = this.normalizeDateUTC(new Date(leave.endDate));
      const windowStart = leaveStart > cycleStartDate ? leaveStart : cycleStartDate;
      const windowEnd = leaveEnd < cycleEndDate ? leaveEnd : cycleEndDate;

      if (windowEnd < windowStart) {
        continue;
      }

      const leavePayablePerDay =
        (leave.durationType ?? 'full_day').toLowerCase() === 'half_day' ? 0.5 : 1;

      const cursor = new Date(windowStart);
      while (cursor <= windowEnd) {
        const key = this.formatDateKey(cursor);
        if (workingDayKeys.has(key)) {
          totalPayableDaysFromLeaves += leavePayablePerDay;
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    const totalPayableDays =
      totalWorkingDays + totalPayableDaysFromLeaves + weekOffDays;

    const payableValues = {
      userId,
      expectedAttendance,
      cycle: cycleKey,
      totalHours: totalHours.toFixed(1),
      totalWorkingDays: totalWorkingDays.toFixed(1),
      weekOff: weekOffDays.toFixed(1),
      totalPayableDays: totalPayableDays.toFixed(1),
      updatedAt: now,
    };

    const [existingPayableRow] = await tx
      .select({ id: payableDaysTable.id })
      .from(payableDaysTable)
      .where(
        and(
          eq(payableDaysTable.userId, userId),
          eq(payableDaysTable.cycle, cycleKey),
        ),
      )
      .orderBy(desc(payableDaysTable.id))
      .limit(1);

    if (existingPayableRow) {
      await tx
        .update(payableDaysTable)
        .set(payableValues)
        .where(eq(payableDaysTable.id, existingPayableRow.id));
      return;
    }

    await tx.insert(payableDaysTable).values({
      ...payableValues,
      createdAt: now,
    });
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
    const allocatedHours = this.normalizeHours(
      snapshot.allocatedHours + (deltas.allocatedHours ?? 0)
    );

    this.ensureNonNegative(balanceHours, "balance");
    this.ensureNonNegative(pendingHours, "pending");
    this.ensureNonNegative(bookedHours, "booked");
    this.ensureNonNegative(allocatedHours, "allocated");

    return {
      id: snapshot.id,
      balanceHours,
      pendingHours,
      bookedHours,
      allocatedHours,
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
        allocatedHours: leaveBalancesTable.allocatedHours,
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
      allocatedHours: Number(row.allocatedHours ?? 0),
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
        allocatedHours: this.formatHours(next.allocatedHours),
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

  /**
   * Queue daily leave notifications for all active leaves
   * Should be called by cron job at 9:00 AM IST every day
   */
  async queueDailyLeaveNotifications() {
    const db = this.database.connection;
    const today = this.normalizeDateUTC(new Date());

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    // Today's leaves
    const todaysLeaves = await db
      .select()
      .from(leaveRequestsTable)
      .where(
        and(
          lte(leaveRequestsTable.startDate, today),
          gte(leaveRequestsTable.endDate, today),
          eq(leaveRequestsTable.state, 'approved')
        )
      );

    // Recently approved past leaves
    const recentlyApprovedPastLeaves = await db
      .select()
      .from(leaveRequestsTable)
      .where(
        and(
          lt(leaveRequestsTable.startDate, today),
          eq(leaveRequestsTable.state, 'approved'),
          gte(leaveRequestsTable.updatedAt, fiveMinutesAgo)
        )
      );

    // Remove duplicates by id
    const allLeaves = Array.from(
      new Map(
        [...todaysLeaves, ...recentlyApprovedPastLeaves].map(l => [l.id, l])
      ).values()
    );

    for (const leave of allLeaves) {
      const payload = {
        leaveId: leave.id,
        userId: leave.userId,
        leaveTypeId: leave.leaveTypeId,
        startDate: leave.startDate,
        endDate: leave.endDate,
        reason: leave.reason
      };

      // check slack notification
      const slackExists = await db
        .select()
        .from(notificationsTable)
        .where(
          and(
            eq(notificationsTable.template, 'leave_request'),
            eq(notificationsTable.channel, 'slack'),
            sql`${notificationsTable.payload}->>'leaveId' = ${String(leave.id)}`,
            gte(notificationsTable.createdAt, today)
          )
        )
        .limit(1);

      // check discord notification
      const discordExists = await db
        .select()
        .from(notificationsTable)
        .where(
          and(
            eq(notificationsTable.template, 'leave_request'),
            eq(notificationsTable.channel, 'discord'),
            sql`${notificationsTable.payload}->>'leaveId' = ${leave.id.toString()}`,
            gte(notificationsTable.createdAt, today)
          )
        )
        .limit(1);

      const notificationsToInsert = [];

      if (slackExists.length === 0) {
        notificationsToInsert.push({
          orgId: leave.orgId,
          channel: 'slack' as const,
          toRef: {},
          template: 'leave_request' as const,
          payload,
          state: 'pending' as const
        });
      }

      if (discordExists.length === 0) {
        notificationsToInsert.push({
          orgId: leave.orgId,
          channel: 'discord' as const,
          toRef: {},
          template: 'leave_request' as const,
          payload,
          state: 'pending' as const
        });
      }

      if (notificationsToInsert.length > 0) {
        await db.insert(notificationsTable).values(notificationsToInsert);
      }
    }

    return { processed: allLeaves.length };
  }

  private isSameDate(date1: Date, date2: Date): boolean {
    const d1 = this.normalizeDateUTC(date1);
    const d2 = this.normalizeDateUTC(date2);
    return d1.getTime() === d2.getTime();
  }

  private async isManagerInHierarchy(
    tx: DatabaseService["connection"],
    requestorUserId: number,
    actionTakerUserId: number,
  ): Promise<boolean> {
    const result = await tx.execute(sql`
      WITH RECURSIVE "ManagerChain" AS (
        -- 1. Base Case: Start with the employee (requestor)
        SELECT
            "id",
            "manager_id",
            1 AS level
        FROM "users"
        WHERE "id" = ${requestorUserId}

        UNION ALL

        -- 2. Recursive Step: Move up the hierarchy
        SELECT
            "u"."id",
            "u"."manager_id",
            "mc"."level" + 1
        FROM "users" "u"
        INNER JOIN "ManagerChain" "mc"
            ON "u"."id" = "mc"."manager_id"
      )
      -- 3. Final Check: Is action-taker in this chain's list of managers?
      -- We check the 'id' column because the chain includes the requestor themself.
      SELECT EXISTS (
          SELECT 1
          FROM "ManagerChain"
          WHERE "id" = ${actionTakerUserId}
      ) AS "is_authorized";
    `);

    const isAuthorized = (result.rows[0] as { is_authorized: boolean })
      .is_authorized;
    return isAuthorized;
  }
}
