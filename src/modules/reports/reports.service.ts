import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gte, lt, lte, sql } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import {
  costRatesTable,
  leaveRequestsTable,
  leaveTypesTable,
  projectsTable,
  timesheetEntriesTable,
  timesheetsTable,
  usersTable,
} from '../../db/schema';
import { CalendarService } from '../calendar/calendar.service';

interface ProductivityParams {
  from?: string;
  to?: string;
  teamId?: number;
  userId?: number;
}

interface ProjectCostParams {
  projectId: number;
  from?: string;
  to?: string;
}

interface EmployeeMonthlySummaryParams {
  userId: number;
  year: number;
  month: number;
}

function normalizeDateUTC(input: Date | string): Date {
  const date = typeof input === 'string' ? new Date(input) : input;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

const HOURS_PER_WORKING_DAY = 8;
const HALF_DAY_HOURS = HOURS_PER_WORKING_DAY / 2;

@Injectable()
export class ReportsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly calendarService: CalendarService,
  ) {}

  async getDailyProductivity(params: ProductivityParams) {
    if (params.userId) {
      if (params.teamId) {
        throw new BadRequestException('Specify either userId or teamId, not both');
      }
      return this.getUserDailyProductivity(params);
    }

    const db = this.database.connection;
    const fromDate = params.from ? new Date(params.from) : undefined;
    const toDateExclusive = params.to
      ? new Date(new Date(params.to).getTime() + 24 * 60 * 60 * 1000)
      : undefined;

    const productivity = await db.execute(
      sql`
        SELECT
          t.work_date::date AS work_date,
          COALESCE(SUM(te.hours_decimal), 0)::numeric AS total_hours,
          COUNT(DISTINCT t.user_id) AS contributor_count
        FROM ${timesheetsTable} t
        LEFT JOIN ${timesheetEntriesTable} te ON te.timesheet_id = t.id
        ${params.teamId ? sql`INNER JOIN ${usersTable} u ON u.id = t.user_id` : sql``}
        WHERE t.state IN ('submitted','approved','locked')
          ${fromDate ? sql`AND t.work_date >= ${fromDate}` : sql``}
          ${toDateExclusive ? sql`AND t.work_date < ${toDateExclusive}` : sql``}
          ${
            params.teamId
              ? sql`AND u.manager_id = ${params.teamId}`
              : sql``
          }
        GROUP BY work_date
        ORDER BY work_date ASC
      `,
    );

    const rows = (productivity.rows as {
      work_date: string | Date;
      total_hours: string | null;
      contributor_count: number;
    }[]).map((row) => ({
      workDate: new Date(row.work_date),
      totalHours: row.total_hours ? Number(row.total_hours) : 0,
      contributorCount: Number(row.contributor_count ?? 0),
    }));

    const totals = rows.reduce(
      (acc, row) => {
        acc.totalHours += row.totalHours;
        acc.totalDays += 1;
        return acc;
      },
      { totalHours: 0, totalDays: 0 },
    );

    return {
      filters: {
        from: fromDate ?? null,
        to: params.to ? new Date(params.to) : null,
        teamId: params.teamId ?? null,
        userId: null,
      },
      summary: {
        totalHours: Number(totals.totalHours.toFixed(2)),
        averageHoursPerDay:
          totals.totalDays > 0
            ? Number((totals.totalHours / totals.totalDays).toFixed(2))
            : 0,
      },
      data: rows,
    };
  }

  private async getUserDailyProductivity(params: ProductivityParams) {
    const db = this.database.connection;
    const userId = params.userId!;
    const [user] = await db
      .select({ id: usersTable.id, orgId: usersTable.orgId })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const now = new Date();
    const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const rangeStart = params.from ? normalizeDateUTC(params.from) : defaultFrom;
    const rangeEnd = params.to ? normalizeDateUTC(params.to) : normalizeDateUTC(now);

    if (rangeEnd < rangeStart) {
      throw new BadRequestException('Parameter "to" must be after "from"');
    }

    const toExclusive = new Date(rangeEnd);
    toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);

    const productivity = await db.execute(
      sql`
        SELECT
          t.work_date::date AS work_date,
          COALESCE(SUM(te.hours_decimal), 0)::numeric AS total_hours
        FROM ${timesheetsTable} t
        LEFT JOIN ${timesheetEntriesTable} te ON te.timesheet_id = t.id
        WHERE t.user_id = ${userId}
          AND t.state IN ('approved','locked')
          AND t.work_date >= ${rangeStart}
          AND t.work_date < ${toExclusive}
        GROUP BY work_date
      `,
    );

    const hourMap = new Map<string, number>();
    (productivity.rows as { work_date: Date | string; total_hours: string | null }[]).forEach((row) => {
      const key = this.formatDateKey(new Date(row.work_date));
      hourMap.set(key, row.total_hours ? Number(row.total_hours) : 0);
    });

    const holidayMap = await this.calendarService.getHolidayMap(
      Number(user.orgId),
      rangeStart,
      rangeEnd,
    );

    const daily: Array<{
      date: Date;
      hours: number;
      isWorkingDay: boolean;
      isWeekend: boolean;
      isHoliday: boolean;
    }> = [];

    let totalWorkingHours = 0;
    let totalWorkingDays = 0;
    const weeklyTotals = new Map<
      string,
      { weekStart: Date; weekNumber: number; hours: number; workingDays: number }
    >();
    const monthlyTotals = new Map<
      string,
      { month: string; hours: number; workingDays: number }
    >();

    const cursor = new Date(rangeStart);
    while (cursor <= rangeEnd) {
      const key = this.formatDateKey(cursor);
      const hours = hourMap.get(key) ?? 0;
      const dayOfWeek = cursor.getUTCDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const holidayOverride = holidayMap.get(key);
      const isWorkingDay = holidayOverride
        ? holidayOverride.isWorkingDay
        : !isWeekend;
      const isHoliday = holidayOverride ? !holidayOverride.isWorkingDay : false;

      if (isWorkingDay) {
        totalWorkingHours += hours;
        totalWorkingDays += 1;

        const weekInfo = this.getWeekInfo(cursor);
        const week = weeklyTotals.get(weekInfo.key) ?? {
          weekStart: weekInfo.start,
          weekNumber: weekInfo.weekNumber,
          hours: 0,
          workingDays: 0,
        };
        week.hours += hours;
        week.workingDays += 1;
        weeklyTotals.set(weekInfo.key, week);

        const monthKey = this.getMonthKey(cursor);
        const monthInfo = monthlyTotals.get(monthKey) ?? {
          month: monthKey,
          hours: 0,
          workingDays: 0,
        };
        monthInfo.hours += hours;
        monthInfo.workingDays += 1;
        monthlyTotals.set(monthKey, monthInfo);
      }

      daily.push({
        date: new Date(cursor),
        hours: Number(hours.toFixed(2)),
        isWorkingDay,
        isWeekend,
        isHoliday,
      });

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const weekly = Array.from(weeklyTotals.values())
      .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime())
      .map((item) => ({
        weekStart: item.weekStart,
        weekNumber: item.weekNumber,
        hours: Number(item.hours.toFixed(2)),
        averageHoursPerDay:
          item.workingDays > 0
            ? Number((item.hours / item.workingDays).toFixed(2))
            : 0,
      }));

    const monthly = Array.from(monthlyTotals.values())
      .sort((a, b) => (a.month < b.month ? -1 : 1))
      .map((item) => ({
        month: item.month,
        hours: Number(item.hours.toFixed(2)),
        averageHoursPerDay:
          item.workingDays > 0
            ? Number((item.hours / item.workingDays).toFixed(2))
            : 0,
      }));

    return {
      filters: {
        from: rangeStart,
        to: rangeEnd,
        userId,
        teamId: null,
      },
      summary: {
        totalWorkingDays,
        totalWorkingHours: Number(totalWorkingHours.toFixed(2)),
        averageHoursPerWorkingDay:
          totalWorkingDays > 0
            ? Number((totalWorkingHours / totalWorkingDays).toFixed(2))
            : 0,
      },
      daily,
      weekly,
      monthly,
    };
  }

  async getEmployeeMonthlySummary(params: EmployeeMonthlySummaryParams) {
    const { userId, year, month } = params;

    if (!userId || !year || !month) {
      throw new BadRequestException('userId, year and month are required');
    }

    if (month < 1 || month > 12) {
      throw new BadRequestException('Month must be between 1 and 12');
    }

    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const nextMonthStart = new Date(Date.UTC(year, month, 1));
    const monthEnd = new Date(nextMonthStart);
    monthEnd.setUTCDate(monthEnd.getUTCDate() - 1);

    const db = this.database.connection;

    const [user] = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        orgId: usersTable.orgId,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const timesheets = await db
      .select({
        id: timesheetsTable.id,
        workDate: timesheetsTable.workDate,
        totalHours: timesheetsTable.totalHours,
        state: timesheetsTable.state,
        notes: timesheetsTable.notes,
        submittedAt: timesheetsTable.submittedAt,
        approvedAt: timesheetsTable.approvedAt,
      })
      .from(timesheetsTable)
      .where(
        and(
          eq(timesheetsTable.userId, userId),
          gte(timesheetsTable.workDate, monthStart),
          lt(timesheetsTable.workDate, nextMonthStart),
        ),
      )
      .orderBy(asc(timesheetsTable.workDate));

    const timesheetMap = new Map<
      string,
      {
        id: number;
        totalHours: number;
        state: string;
        notes: string | null;
        submittedAt: Date | null;
        approvedAt: Date | null;
      }
    >();

    timesheets.forEach((row) => {
      const workDate = normalizeDateUTC(new Date(row.workDate));
      const key = this.formatDateKey(workDate);
      timesheetMap.set(key, {
        id: row.id,
        totalHours: row.totalHours ? Number(row.totalHours) : 0,
        state: row.state,
        notes: row.notes ?? null,
        submittedAt: row.submittedAt ? new Date(row.submittedAt) : null,
        approvedAt: row.approvedAt ? new Date(row.approvedAt) : null,
      });
    });

    const leaveRequests = await db
      .select({
        id: leaveRequestsTable.id,
        startDate: leaveRequestsTable.startDate,
        endDate: leaveRequestsTable.endDate,
        hours: leaveRequestsTable.hours,
        state: leaveRequestsTable.state,
        durationType: leaveRequestsTable.durationType,
        halfDaySegment: leaveRequestsTable.halfDaySegment,
        reason: leaveRequestsTable.reason,
        leaveTypeId: leaveRequestsTable.leaveTypeId,
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
          lte(leaveRequestsTable.startDate, nextMonthStart),
          gte(leaveRequestsTable.endDate, monthStart),
        ),
      )
      .orderBy(asc(leaveRequestsTable.startDate));

    const monthWorkingInfo = await this.getWorkingDayInfo(
      Number(user.orgId),
      monthStart,
      monthEnd,
    );

    const leaveDaily = new Map<
      string,
      {
        totalHours: number;
        entries: Array<{
          requestId: number;
          state: string;
          durationType: string;
          halfDaySegment: string | null;
          hours: number;
          leaveType: { id: number; code: string | null; name: string | null };
        }>;
      }
    >();
    let totalLeaveHours = 0;

    for (const request of leaveRequests) {
      const requestStart = normalizeDateUTC(new Date(request.startDate));
      const requestEnd = normalizeDateUTC(new Date(request.endDate));
      const requestHours = request.hours ? Number(request.hours) : 0;

      const workingInfo = await this.getWorkingDayInfo(
        Number(user.orgId),
        requestStart,
        requestEnd,
      );

      const workingDayKeys = Array.from(workingInfo.entries())
        .filter(([, info]) => info.isWorkingDay)
        .map(([key]) => key);

      if (workingDayKeys.length === 0) {
        continue;
      }

      const perDayHours =
        request.durationType === 'half_day' || workingDayKeys.length === 0
          ? 0
          : requestHours / workingDayKeys.length;

      let halfDayAssigned = false;

      for (const key of workingDayKeys) {
        let hoursForDay: number;

        if (request.durationType === 'half_day') {
          if (halfDayAssigned) {
            continue;
          }
          const halfDayHours =
            requestHours > 0 ? requestHours : HALF_DAY_HOURS;
          hoursForDay = halfDayHours;
          halfDayAssigned = true;
        } else {
          hoursForDay = perDayHours;
        }

        const dayDate = new Date(`${key}T00:00:00.000Z`);
        const isWithinMonth = dayDate >= monthStart && dayDate <= monthEnd;

        if (!isWithinMonth || hoursForDay <= 0) {
          continue;
        }

        const bucket = leaveDaily.get(key) ?? { totalHours: 0, entries: [] };
        bucket.totalHours += hoursForDay;
        bucket.entries.push({
          requestId: request.id,
          state: request.state,
          durationType: request.durationType,
          halfDaySegment: request.halfDaySegment ?? null,
          hours: Number(hoursForDay.toFixed(2)),
          leaveType: {
            id: request.leaveTypeId,
            code: request.leaveTypeCode,
            name: request.leaveTypeName,
          },
        });
        leaveDaily.set(key, bucket);
        totalLeaveHours += hoursForDay;
      }
    }

    const days: Array<{
      date: Date;
      isWorkingDay: boolean;
      isHoliday: boolean;
      isWeekend: boolean;
      timesheet: {
        id: number;
        state: string;
        totalHours: number;
        notes: string | null;
        submittedAt: Date | null;
        approvedAt: Date | null;
      } | null;
      leave: {
        totalHours: number;
        entries: Array<{
          requestId: number;
          state: string;
          durationType: string;
          halfDaySegment: string | null;
          hours: number;
          leaveType: { id: number; code: string | null; name: string | null };
        }>;
      };
    }> = [];

    let totalTimesheetHours = 0;

    const cursor = new Date(monthStart);
    while (cursor <= monthEnd) {
      const key = this.formatDateKey(cursor);
      const info =
        monthWorkingInfo.get(key) ?? {
          isWorkingDay: true,
          isHoliday: false,
          isWeekend: false,
        };
      const timesheet = timesheetMap.get(key);
      const leaveInfo = leaveDaily.get(key);

      totalTimesheetHours += timesheet?.totalHours ?? 0;

      const dayDate = new Date(cursor);
      days.push({
        date: dayDate,
        isWorkingDay: info.isWorkingDay,
        isHoliday: info.isHoliday,
        isWeekend: info.isWeekend,
        timesheet: timesheet
          ? {
              id: timesheet.id,
              state: timesheet.state,
              totalHours: Number(timesheet.totalHours.toFixed(2)),
              notes: timesheet.notes,
              submittedAt: timesheet.submittedAt,
              approvedAt: timesheet.approvedAt,
            }
          : null,
        leave: leaveInfo
          ? {
              totalHours: Number(leaveInfo.totalHours.toFixed(2)),
              entries: leaveInfo.entries,
            }
          : { totalHours: 0, entries: [] },
      });

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return {
      user: {
        id: user.id,
        name: user.name ?? null,
        email: user.email ?? null,
      },
      period: {
        year,
        month,
        start: monthStart,
        end: monthEnd,
      },
      totals: {
        timesheetHours: Number(totalTimesheetHours.toFixed(2)),
        leaveHours: Number(totalLeaveHours.toFixed(2)),
      },
      leaveRequests: leaveRequests.map((request) => ({
        id: request.id,
        startDate: new Date(request.startDate),
        endDate: new Date(request.endDate),
        hours: request.hours ? Number(request.hours) : 0,
        state: request.state,
        durationType: request.durationType,
        reason: request.reason ?? null,
        leaveType: {
          id: request.leaveTypeId,
          code: request.leaveTypeCode,
          name: request.leaveTypeName,
        },
      })),
      days,
    };
  }

  async getProjectCostBreakdown(params: ProjectCostParams) {
    const db = this.database.connection;
    const [project] = await db
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        budgetCurrency: projectsTable.budgetCurrency,
        budgetAmountMinor: projectsTable.budgetAmountMinor,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, params.projectId))
      .limit(1);

    if (!project) {
      throw new NotFoundException(
        `Project ${params.projectId} not found for reporting`,
      );
    }

    const fromDate = params.from ? new Date(params.from) : undefined;
    const toDate = params.to ? new Date(params.to) : undefined;
    const toDateExclusive = toDate
      ? new Date(toDate.getTime() + 24 * 60 * 60 * 1000)
      : undefined;

    const contributorRows = await db.execute(
      sql`
        SELECT
          t.user_id AS user_id,
          u.name AS user_name,
          u.email AS user_email,
          COALESCE(SUM(te.hours_decimal), 0)::numeric AS total_hours,
          COALESCE(SUM(te.hours_decimal * cr.hourly_cost_minor_currency), 0)::numeric AS total_cost_minor
        FROM ${timesheetsTable} t
        INNER JOIN ${timesheetEntriesTable} te ON te.timesheet_id = t.id
        LEFT JOIN ${costRatesTable} cr
          ON cr.user_id = t.user_id
         AND cr.effective_from <= t.work_date
         AND (cr.effective_to IS NULL OR cr.effective_to >= t.work_date)
        LEFT JOIN ${usersTable} u ON u.id = t.user_id
        WHERE te.project_id = ${params.projectId}
          AND t.state IN ('approved','locked')
          ${fromDate ? sql`AND t.work_date >= ${fromDate}` : sql``}
          ${toDateExclusive ? sql`AND t.work_date < ${toDateExclusive}` : sql``}
        GROUP BY t.user_id, u.name, u.email
        ORDER BY total_hours DESC
      `,
    );

    const contributors = (contributorRows.rows as {
      user_id: number;
      user_name: string | null;
      user_email: string | null;
      total_hours: string | null;
      total_cost_minor: string | null;
    }[]).map((row) => {
      const totalHours = row.total_hours ? Number(row.total_hours) : 0;
      const totalCostMinor = row.total_cost_minor
        ? Number(row.total_cost_minor)
        : 0;
      return {
        userId: Number(row.user_id),
        userName: row.user_name ?? null,
        userEmail: row.user_email ?? null,
        totalHours: Number(totalHours.toFixed(2)),
        totalCostMinor: Math.round(totalCostMinor),
        averageHourlyCostMinor:
          totalHours > 0 ? Math.round(totalCostMinor / totalHours) : 0,
      };
    });

    const totals = contributors.reduce(
      (acc, item) => {
        acc.totalHours += item.totalHours;
        acc.totalCostMinor += item.totalCostMinor;
        return acc;
      },
      { totalHours: 0, totalCostMinor: 0 },
    );

    const averageHourlyCostMinor =
      totals.totalHours > 0
        ? Math.round(totals.totalCostMinor / totals.totalHours)
        : 0;

    return {
      project: {
        id: project.id,
        name: project.name,
        budgetAmountMinor: project.budgetAmountMinor,
        budgetCurrency: project.budgetCurrency,
      },
      filters: {
        from: fromDate ?? null,
        to: toDate ?? null,
      },
      totals: {
        totalHours: Number(totals.totalHours.toFixed(2)),
        totalCostMinor: Math.round(totals.totalCostMinor),
        averageHourlyCostMinor,
        currency: project.budgetCurrency ?? null,
      },
      contributors,
    };
  }

  private async getWorkingDayInfo(
    orgId: number,
    start: Date,
    end: Date,
  ): Promise<
    Map<string, { isWorkingDay: boolean; isHoliday: boolean; isWeekend: boolean }>
  > {
    const normalizedStart = normalizeDateUTC(start);
    const normalizedEnd = normalizeDateUTC(end);

    if (normalizedEnd < normalizedStart) {
      return new Map();
    }

    const holidayMap = await this.calendarService.getHolidayMap(
      orgId,
      normalizedStart,
      normalizedEnd,
    );

    const info = new Map<
      string,
      { isWorkingDay: boolean; isHoliday: boolean; isWeekend: boolean }
    >();

    const cursor = new Date(normalizedStart);
    while (cursor <= normalizedEnd) {
      const key = this.formatDateKey(cursor);
      const dayOfWeek = cursor.getUTCDay();
      const isSunday = dayOfWeek === 0;
      const isSaturday = dayOfWeek === 6;
      const isSecondFourthSaturday =
        isSaturday && this.isSecondOrFourthSaturday(cursor);
      const override = holidayMap.get(key);
      const defaultWorking = !(isSunday || isSecondFourthSaturday);
      const isWorkingDay = override ? override.isWorkingDay : defaultWorking;
      const isHoliday = override ? !override.isWorkingDay : false;

      info.set(key, {
        isWorkingDay,
        isHoliday,
        isWeekend: isSunday || isSaturday,
      });

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return info;
  }

  private isSecondOrFourthSaturday(date: Date): boolean {
    const occurrence = Math.ceil(date.getUTCDate() / 7);
    return occurrence === 2 || occurrence === 4;
  }

  private formatDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private getWeekInfo(date: Date) {
    const day = date.getUTCDay();
    const diff = (day + 6) % 7; // convert Sunday=0 to Monday=0
    const start = new Date(date);
    start.setUTCDate(start.getUTCDate() - diff);
    const yearStart = new Date(Date.UTC(start.getUTCFullYear(), 0, 1));
    const weekNumber = Math.floor(
      ((start.getTime() - yearStart.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1,
    );
    const key = `${start.getUTCFullYear()}-W${weekNumber.toString().padStart(2, '0')}`;
    return { key, start, weekNumber };
  }

  private getMonthKey(date: Date) {
    const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
    return `${date.getUTCFullYear()}-${month}`;
  }

  async getProjectCosts(params: ProjectCostParams) {
    const db = this.database.connection;
    const [project] = await db
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        budgetCurrency: projectsTable.budgetCurrency,
        budgetAmountMinor: projectsTable.budgetAmountMinor,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, params.projectId))
      .limit(1);

    if (!project) {
      throw new NotFoundException(
        `Project ${params.projectId} not found for reporting`,
      );
    }

    const fromDate = params.from ? new Date(params.from) : undefined;
    const toDateExclusive = params.to
      ? new Date(new Date(params.to).getTime() + 24 * 60 * 60 * 1000)
      : undefined;

    const costRows = await db.execute(
      sql`
        SELECT
          t.work_date::date AS work_date,
          COALESCE(SUM(te.hours_decimal), 0)::numeric AS total_hours
        FROM ${timesheetsTable} t
        INNER JOIN ${timesheetEntriesTable} te ON te.timesheet_id = t.id
        WHERE te.project_id = ${params.projectId}
          AND t.state IN ('approved','locked')
          ${fromDate ? sql`AND t.work_date >= ${fromDate}` : sql``}
          ${toDateExclusive ? sql`AND t.work_date < ${toDateExclusive}` : sql``}
        GROUP BY work_date
        ORDER BY work_date ASC
      `,
    );

    const data = (costRows.rows as {
      work_date: string | Date;
      total_hours: string | null;
    }[]).map((row) => ({
      workDate: new Date(row.work_date),
      totalHours: row.total_hours ? Number(row.total_hours) : 0,
    }));

    const totalHours = data.reduce((acc, row) => acc + row.totalHours, 0);
    return {
      project: {
        id: project.id,
        name: project.name,
        budgetAmountMinor: project.budgetAmountMinor,
        budgetCurrency: project.budgetCurrency,
      },
      filters: {
        from: fromDate ?? null,
        to: params.to ? new Date(params.to) : null,
      },
      totals: {
        totalHours: Number(totalHours.toFixed(2)),
      },
      data,
    };
  }
}
