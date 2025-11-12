import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { DatabaseService } from '../../database/database.service';
import { departmentsTable, leaveRequestsTable, leaveTypesTable, projectsTable, timesheetEntriesTable, timesheetsTable, usersTable } from '../../db/schema';
import { CalendarService } from '../calendar/calendar.service';
import { CreateTimesheetDto } from './dto/create-timesheet.dto';

interface ListTimesheetParams {
  userId?: number;
  from?: string;
  to?: string;
  state?: string;
}

const MAX_BACKFILL_PER_MONTH = 3;
const MAX_HOURS_PER_DAY = 15;
const HOURS_PER_WORKING_DAY = 8;
const HALF_DAY_HOURS = HOURS_PER_WORKING_DAY / 2;

function normalizeDate(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

@Injectable()
export class TimesheetsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly calendarService: CalendarService
  ) {}

  async listTimesheets(params: ListTimesheetParams) {
    const db = this.database.connection;

    const filters = [];
    if (params.userId) {
      filters.push(eq(timesheetsTable.userId, params.userId));
    }
    if (params.state) {
      const allowedStates = [
        "draft",
        "submitted",
        "approved",
        "rejected",
        "locked",
      ] as const;
      if (allowedStates.includes(params.state as any)) {
        filters.push(
          eq(
            timesheetsTable.state,
            params.state as (typeof allowedStates)[number]
          )
        );
      } else {
        throw new BadRequestException(`Invalid state: ${params.state}`);
      }
    }
    if (params.from) {
      filters.push(
        gte(timesheetsTable.workDate, normalizeDate(new Date(params.from)))
      );
    }
    if (params.to) {
      filters.push(
        lte(timesheetsTable.workDate, normalizeDate(new Date(params.to)))
      );
    }

    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    const baseQuery = db
      .select({
        id: timesheetsTable.id,
        userId: timesheetsTable.userId,
        orgId: timesheetsTable.orgId,
        workDate: timesheetsTable.workDate,
        state: timesheetsTable.state,
        totalHours: timesheetsTable.totalHours,
        notes: timesheetsTable.notes,
        submittedAt: timesheetsTable.submittedAt,
        approvedAt: timesheetsTable.approvedAt,
        rejectedAt: timesheetsTable.rejectedAt,
        lockedAt: timesheetsTable.lockedAt,
        createdAt: timesheetsTable.createdAt,
        updatedAt: timesheetsTable.updatedAt,
      })
      .from(timesheetsTable);

    const filteredQuery = whereClause
      ? baseQuery.where(whereClause)
      : baseQuery;

    const timesheets = await filteredQuery.orderBy(
      desc(timesheetsTable.workDate),
      desc(timesheetsTable.id)
    );

    const timesheetIds = timesheets.map((t) => t.id);

    const entries =
      timesheetIds.length === 0
        ? []
        : await db
            .select({
              id: timesheetEntriesTable.id,
              timesheetId: timesheetEntriesTable.timesheetId,
              projectId: timesheetEntriesTable.projectId,
              taskTitle: timesheetEntriesTable.taskTitle,
              taskDescription: timesheetEntriesTable.taskDescription,
              hoursDecimal: timesheetEntriesTable.hoursDecimal,
              tags: timesheetEntriesTable.tags,
              createdAt: timesheetEntriesTable.createdAt,
              updatedAt: timesheetEntriesTable.updatedAt,
            })
            .from(timesheetEntriesTable)
            .where(inArray(timesheetEntriesTable.timesheetId, timesheetIds))
            .orderBy(asc(timesheetEntriesTable.id));

    const entriesByTimesheet = entries.reduce<Record<number, typeof entries>>(
      (acc, entry) => {
        acc[entry.timesheetId] = acc[entry.timesheetId] ?? [];
        acc[entry.timesheetId].push(entry);
        return acc;
      },
      {}
    );

    const data = timesheets.map((timesheet) => ({
      ...timesheet,
      entries: entriesByTimesheet[timesheet.id] ?? [],
    }));

    return {
      data,
      total: data.length,
    };
  }

  async createOrUpsert(
    payload: CreateTimesheetDto,
    userId: number,
    orgId: number
  ) {
    const db = this.database.connection;
    const workDate = normalizeDate(new Date(payload.workDate));
    const now = new Date();

    if (!payload.entries || payload.entries.length === 0) {
      throw new BadRequestException("At least one entry is required");
    }

    const normalizedEntriesMap = new Map<
      string,
      {
        projectId: number | null;
        taskTitle: string | null;
        taskDescription: string | null;
        hours: number;
        tags: string[];
      }
    >();

    payload.entries.forEach((entry, index) => {
      const projectIdRaw = entry.projectId;
      let projectId: number | null = null;

      if (projectIdRaw !== undefined && projectIdRaw !== null) {
        const parsed = Number.parseInt(String(projectIdRaw), 10);
        if (Number.isNaN(parsed)) {
          throw new BadRequestException(
            `Entry ${index + 1} has an invalid projectId`
          );
        }
        projectId = parsed;
      }

      const taskTitle =
        entry.taskTitle && entry.taskTitle.trim().length > 0
          ? entry.taskTitle.trim()
          : null;

      const tags = Array.isArray(entry.tags)
        ? entry.tags.filter((tag) => typeof tag === "string" && tag.trim() !== "")
        : [];

      const hours = Number(entry.hours);
      if (Number.isNaN(hours) || hours <= 0) {
        throw new BadRequestException(
          `Entry ${index + 1} must include a valid positive number of hours`
        );
      }

      const normalized = {
        projectId,
        taskTitle,
        taskDescription:
          entry.taskDescription && entry.taskDescription.trim().length > 0
            ? entry.taskDescription.trim()
            : null,
        hours,
        tags,
      };

      const key = projectId === null ? "__null__" : projectId.toString();
      normalizedEntriesMap.set(key, normalized);
    });

    const normalizedEntries = Array.from(normalizedEntriesMap.values());
    const totalHoursForDay = normalizedEntries.reduce(
      (acc, entry) => acc + entry.hours,
      0
    );

    if (totalHoursForDay > MAX_HOURS_PER_DAY) {
      throw new BadRequestException(
        `Timesheet hours cannot exceed ${MAX_HOURS_PER_DAY} hours per day`
      );
    }

    const projectIds = Array.from(
      new Set(
        normalizedEntries
          .map((entry) => (entry.projectId !== null ? entry.projectId : null))
          .filter((value): value is number => value !== null)
      )
    );

    if (projectIds.length > 0) {
      const projects = await db
        .select({
          id: projectsTable.id,
          orgId: projectsTable.orgId,
        })
        .from(projectsTable)
        .where(inArray(projectsTable.id, projectIds));

      const validProjectIds = new Set(
        projects
          .filter((project) => Number(project.orgId) === orgId)
          .map((project) => project.id),
      );

      const missing = projectIds.filter((id) => !validProjectIds.has(id));

      if (missing.length > 0) {
        throw new BadRequestException(
          `Projects not found in organisation: ${missing.join(', ')}`,
        );
      }
    }

    const today = normalizeDate(now);
    if (workDate > today) {
      throw new BadRequestException("Cannot create timesheet for future date");
    }

    if (await this.calendarService.isHoliday(orgId, workDate)) {
      throw new BadRequestException(
        "Timesheets cannot be logged on holidays or non-working days"
      );
    }

    const isBackfill = workDate < today;
    const currentBackfillUsage = await this.countBackfilledDaysForMonth(
      userId,
      workDate,
      now
    );

    if (isBackfill) {
      if (currentBackfillUsage >= MAX_BACKFILL_PER_MONTH) {
        throw new BadRequestException(
          `Backfilling is limited to ${MAX_BACKFILL_PER_MONTH} days per month`
        );
      }
    }

    const [existing] = await db
      .select({
        id: timesheetsTable.id,
        state: timesheetsTable.state,
        notes: timesheetsTable.notes,
      })
      .from(timesheetsTable)
      .where(
        and(
          eq(timesheetsTable.userId, userId),
          eq(timesheetsTable.orgId, orgId),
          eq(timesheetsTable.workDate, workDate)
        )
      )
      .limit(1);

    if (
      existing &&
      ["submitted", "approved", "locked"].includes(existing.state)
    ) {
      throw new BadRequestException(
        `Cannot modify timesheet when it is ${existing.state}`
      );
    }

    const notesToPersist = payload.notes ?? existing?.notes ?? null;

    const result = await db.transaction(async (tx) => {
      let timesheetId: number;

      if (!existing) {
        const [created] = await tx
          .insert(timesheetsTable)
          .values({
            orgId,
            userId,
            workDate,
            notes: notesToPersist,
            state: "draft",
            totalHours: "0",
            submittedAt: now,
          })
          .returning({ id: timesheetsTable.id });
        timesheetId = created.id;
      } else {
        timesheetId = existing.id;
        await tx
          .update(timesheetsTable)
          .set({
            notes: notesToPersist,
            submittedAt: now,
            updatedAt: now,
          })
          .where(eq(timesheetsTable.id, timesheetId));
      }

      if (normalizedEntries.length > 0) {
        const nonNullProjectIds = Array.from(
          new Set(
            normalizedEntries
              .map((entry) => entry.projectId)
              .filter((id): id is number => id !== null)
          )
        );
        const includesNullProject = normalizedEntries.some(
          (entry) => entry.projectId === null
        );

        const projectConditions = [];
        if (nonNullProjectIds.length > 0) {
          projectConditions.push(
            inArray(timesheetEntriesTable.projectId, nonNullProjectIds)
          );
        }
        if (includesNullProject) {
          projectConditions.push(isNull(timesheetEntriesTable.projectId));
        }

        if (projectConditions.length > 0) {
          await tx
            .delete(timesheetEntriesTable)
            .where(
              and(
                eq(timesheetEntriesTable.timesheetId, timesheetId),
                projectConditions.length === 1
                  ? projectConditions[0]
                  : or(...projectConditions)
              )
            );
        }

        await tx.insert(timesheetEntriesTable).values(
          normalizedEntries.map((entry) => ({
            orgId,
            timesheetId,
            projectId: entry.projectId,
            taskTitle: entry.taskTitle,
            taskDescription: entry.taskDescription ?? null,
            hoursDecimal: entry.hours.toString(),
            tags: entry.tags ?? [],
            createdAt: now,
            updatedAt: now,
          })),
        );
      }

      const [{ totalHours }] = await tx
        .select({
          totalHours: sql<number>`COALESCE(SUM(${timesheetEntriesTable.hoursDecimal}), 0)`,
        })
        .from(timesheetEntriesTable)
        .where(eq(timesheetEntriesTable.timesheetId, timesheetId));

      const [storedTimesheet] = await tx
        .update(timesheetsTable)
        .set({
          totalHours: String(totalHours ?? 0),
          submittedAt: now,
          updatedAt: now,
        })
        .where(eq(timesheetsTable.id, timesheetId))
        .returning({
          id: timesheetsTable.id,
          userId: timesheetsTable.userId,
          orgId: timesheetsTable.orgId,
          workDate: timesheetsTable.workDate,
          state: timesheetsTable.state,
          totalHours: timesheetsTable.totalHours,
          notes: timesheetsTable.notes,
          submittedAt: timesheetsTable.submittedAt,
          approvedAt: timesheetsTable.approvedAt,
          rejectedAt: timesheetsTable.rejectedAt,
          lockedAt: timesheetsTable.lockedAt,
          createdAt: timesheetsTable.createdAt,
          updatedAt: timesheetsTable.updatedAt,
        });

      const savedEntries = await tx
        .select({
          id: timesheetEntriesTable.id,
          timesheetId: timesheetEntriesTable.timesheetId,
          projectId: timesheetEntriesTable.projectId,
          taskTitle: timesheetEntriesTable.taskTitle,
          taskDescription: timesheetEntriesTable.taskDescription,
          hoursDecimal: timesheetEntriesTable.hoursDecimal,
          tags: timesheetEntriesTable.tags,
          createdAt: timesheetEntriesTable.createdAt,
          updatedAt: timesheetEntriesTable.updatedAt,
        })
        .from(timesheetEntriesTable)
        .where(eq(timesheetEntriesTable.timesheetId, timesheetId))
        .orderBy(asc(timesheetEntriesTable.id));

      return {
        timesheet: storedTimesheet,
        entries: savedEntries,
      };
    });

    const usageAfterOperation = await this.countBackfilledDaysForMonth(
      userId,
      workDate,
      now
    );

    const backfillRemaining = isBackfill
      ? Math.max(MAX_BACKFILL_PER_MONTH - usageAfterOperation, 0)
      : Math.max(MAX_BACKFILL_PER_MONTH - currentBackfillUsage, 0);

    return {
      ...result.timesheet,
      entries: result.entries,
      backfillLimit: MAX_BACKFILL_PER_MONTH,
      backfillRemaining,
    };
  }

  async getMonthlyDashboard(params: {
    userId: number;
    orgId: number;
    year: number;
    month: number;
  }) {
    const { userId, orgId, year, month } = params;

    if (!year || !month) {
      throw new BadRequestException('year and month are required');
    }
    if (month < 1 || month > 12) {
      throw new BadRequestException('month must be between 1 and 12');
    }

    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const nextMonthStart = new Date(Date.UTC(year, month, 1));
    const monthEnd = new Date(nextMonthStart);
    monthEnd.setUTCDate(monthEnd.getUTCDate() - 1);

    const db = this.database.connection;

    const [user] = await db
      .select({
        id: usersTable.id,
        orgId: usersTable.orgId,
        name: usersTable.name,
        employeeDepartmentId: usersTable.employeeDepartmentId,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user || Number(user.orgId) !== orgId) {
      throw new NotFoundException('User not found for this organisation');
    }

    const timesheets = await db
      .select({
        id: timesheetsTable.id,
        workDate: timesheetsTable.workDate,
        state: timesheetsTable.state,
        totalHours: timesheetsTable.totalHours,
        notes: timesheetsTable.notes,
        submittedAt: timesheetsTable.submittedAt,
        approvedAt: timesheetsTable.approvedAt,
        rejectedAt: timesheetsTable.rejectedAt,
        lockedAt: timesheetsTable.lockedAt,
        createdAt: timesheetsTable.createdAt,
        updatedAt: timesheetsTable.updatedAt,
      })
      .from(timesheetsTable)
      .where(
        and(
          eq(timesheetsTable.userId, userId),
          eq(timesheetsTable.orgId, orgId),
          gte(timesheetsTable.workDate, monthStart),
          lt(timesheetsTable.workDate, nextMonthStart),
        ),
      )
      .orderBy(asc(timesheetsTable.workDate));

    const timesheetIds = timesheets.map((row) => row.id);

    const entryRows =
      timesheetIds.length === 0
        ? []
        : await db
            .select({
              id: timesheetEntriesTable.id,
              timesheetId: timesheetEntriesTable.timesheetId,
              projectId: timesheetEntriesTable.projectId,
              projectName: projectsTable.name,
              departmentId: departmentsTable.id,
              departmentName: departmentsTable.name,
              taskTitle: timesheetEntriesTable.taskTitle,
              taskDescription: timesheetEntriesTable.taskDescription,
              hoursDecimal: timesheetEntriesTable.hoursDecimal,
              tags: timesheetEntriesTable.tags,
              createdAt: timesheetEntriesTable.createdAt,
              updatedAt: timesheetEntriesTable.updatedAt,
            })
            .from(timesheetEntriesTable)
            .leftJoin(
              projectsTable,
              eq(projectsTable.id, timesheetEntriesTable.projectId),
            )
            .leftJoin(
              departmentsTable,
              eq(departmentsTable.id, projectsTable.departmentId),
            )
            .where(inArray(timesheetEntriesTable.timesheetId, timesheetIds))
            .orderBy(asc(timesheetEntriesTable.id));

    const entriesByTimesheet = new Map<
      number,
      Array<{
        id: number;
        projectId: number | null;
        projectName: string | null;
        departmentId: number | null;
        departmentName: string | null;
        taskTitle: string | null;
        taskDescription: string | null;
        hours: number;
        tags: string[];
        createdAt: Date | null;
        updatedAt: Date | null;
      }>
    >();

    for (const entry of entryRows) {
      const bucket =
        entriesByTimesheet.get(entry.timesheetId) ??
        ([] as Array<{
          id: number;
          projectId: number | null;
          projectName: string | null;
          departmentId: number | null;
          departmentName: string | null;
          taskTitle: string | null;
          taskDescription: string | null;
          hours: number;
          tags: string[];
          createdAt: Date | null;
          updatedAt: Date | null;
        }>);

      bucket.push({
        id: entry.id,
        projectId: entry.projectId ?? null,
        projectName: entry.projectName ?? null,
        departmentId: entry.departmentId ?? null,
        departmentName: entry.departmentName ?? null,
        taskTitle: entry.taskTitle ?? null,
        taskDescription: entry.taskDescription ?? null,
        hours: entry.hoursDecimal ? Number(entry.hoursDecimal) : 0,
        tags: entry.tags ?? [],
        createdAt: entry.createdAt ?? null,
        updatedAt: entry.updatedAt ?? null,
      });

      entriesByTimesheet.set(entry.timesheetId, bucket);
    }

    const timesheetMap = new Map<
      string,
      {
        id: number;
        state: string;
        totalHours: number;
        notes: string | null;
        submittedAt: Date | null;
        approvedAt: Date | null;
        rejectedAt: Date | null;
        lockedAt: Date | null;
        createdAt: Date | null;
        updatedAt: Date | null;
        entries: Array<{
          id: number;
          projectId: number | null;
          projectName: string | null;
          departmentId: number | null;
          departmentName: string | null;
          taskTitle: string | null;
          taskDescription: string | null;
          hours: number;
          tags: string[];
          createdAt: Date | null;
          updatedAt: Date | null;
        }>;
      }
    >();

    for (const row of timesheets) {
      const workDate = new Date(row.workDate);
      const key = this.formatDateKey(workDate);
      timesheetMap.set(key, {
        id: row.id,
        state: row.state,
        totalHours: row.totalHours ? Number(row.totalHours) : 0,
        notes: row.notes ?? null,
        submittedAt: row.submittedAt ? new Date(row.submittedAt) : null,
        approvedAt: row.approvedAt ? new Date(row.approvedAt) : null,
        rejectedAt: row.rejectedAt ? new Date(row.rejectedAt) : null,
        lockedAt: row.lockedAt ? new Date(row.lockedAt) : null,
        createdAt: row.createdAt ? new Date(row.createdAt) : null,
        updatedAt: row.updatedAt ? new Date(row.updatedAt) : null,
        entries: entriesByTimesheet.get(row.id) ?? [],
      });
    }

    const leaveRequests = await db
      .select({
        id: leaveRequestsTable.id,
        startDate: leaveRequestsTable.startDate,
        endDate: leaveRequestsTable.endDate,
        hours: leaveRequestsTable.hours,
        state: leaveRequestsTable.state,
        durationType: leaveRequestsTable.durationType,
        halfDaySegment: leaveRequestsTable.halfDaySegment,
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

    const workingDayInfo = await this.getWorkingDayInfo(orgId, monthStart, monthEnd);

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
          leaveType: {
            id: number;
            code: string | null;
            name: string | null;
          };
        }>;
      }
    >();

    let totalLeaveHours = 0;

    for (const request of leaveRequests) {
      const requestStart = this.normalizeDateUTC(new Date(request.startDate));
      const requestEnd = this.normalizeDateUTC(new Date(request.endDate));

      const windowStart = requestStart > monthStart ? requestStart : monthStart;
      const windowEnd = requestEnd < monthEnd ? requestEnd : monthEnd;

      if (windowEnd < windowStart) {
        continue;
      }

      const dayKeys: string[] = [];
      const cursor = new Date(windowStart);
      while (cursor <= windowEnd) {
        const key = this.formatDateKey(cursor);
        const info = workingDayInfo.get(key);
        if (info?.isWorkingDay) {
          dayKeys.push(key);
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      if (dayKeys.length === 0) {
        continue;
      }

      const requestHours = request.hours ? Number(request.hours) : 0;
      const perDayHours =
        request.durationType === 'half_day' || dayKeys.length === 0
          ? 0
          : requestHours / dayKeys.length;

      let halfDayAssigned = false;

      for (const key of dayKeys) {
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

        if (hoursForDay <= 0) {
          continue;
        }

        totalLeaveHours += hoursForDay;

        const bucket =
          leaveDaily.get(key) ??
          ({
            totalHours: 0,
            entries: [],
          } as {
            totalHours: number;
            entries: Array<{
              requestId: number;
              state: string;
              durationType: string;
              halfDaySegment: string | null;
              hours: number;
              leaveType: {
                id: number;
                code: string | null;
                name: string | null;
              };
            }>;
          });

        bucket.totalHours += hoursForDay;
        bucket.entries.push({
          requestId: request.id,
          state: request.state,
          durationType: request.durationType,
          halfDaySegment: request.halfDaySegment ?? null,
          hours: Number(hoursForDay.toFixed(2)),
          leaveType: {
            id: request.leaveTypeId,
            code: request.leaveTypeCode ?? null,
            name: request.leaveTypeName ?? null,
          },
        });

        leaveDaily.set(key, bucket);
      }
    }

    const totalTimesheetHours = timesheets.reduce((acc, row) => {
      const hours = row.totalHours ? Number(row.totalHours) : 0;
      return acc + hours;
    }, 0);

    const days: Array<{
      date: string;
      isWorkingDay: boolean;
      isWeekend: boolean;
      isHoliday: boolean;
      timesheet:
        | ({
            id: number;
            state: string;
            totalHours: number;
            notes: string | null;
            submittedAt: Date | null;
            approvedAt: Date | null;
            rejectedAt: Date | null;
            lockedAt: Date | null;
            createdAt: Date | null;
            updatedAt: Date | null;
          } & {
            entries: Array<{
              id: number;
              projectId: number | null;
              projectName: string | null;
              departmentId: number | null;
              departmentName: string | null;
              taskTitle: string | null;
              taskDescription: string | null;
              hours: number;
              tags: string[];
              createdAt: Date | null;
              updatedAt: Date | null;
            }>;
          })
        | null;
      leaves: {
        totalHours: number;
        entries: Array<{
          requestId: number;
          state: string;
          durationType: string;
          halfDaySegment: string | null;
          hours: number;
          leaveType: {
            id: number;
            code: string | null;
            name: string | null;
          };
        }>;
      } | null;
    }> = [];

    const cursor = new Date(monthStart);
    while (cursor <= monthEnd) {
      const key = this.formatDateKey(cursor);
      const info = workingDayInfo.get(key);
      const timesheet = timesheetMap.get(key) ?? null;
      const leaveInfo = leaveDaily.get(key) ?? null;

      days.push({
        date: key,
        isWorkingDay: info?.isWorkingDay ?? false,
        isWeekend: info?.isWeekend ?? false,
        isHoliday: info?.isHoliday ?? false,
        timesheet,
        leaves: leaveInfo
          ? {
              totalHours: Number(leaveInfo.totalHours.toFixed(2)),
              entries: leaveInfo.entries,
            }
          : null,
      });

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return {
      user: {
        id: user.id,
        name: user.name,
        employeeDepartmentId:
          user.employeeDepartmentId ?? null,
      },
      period: {
        year,
        month,
        start: this.formatDateKey(monthStart),
        end: this.formatDateKey(monthEnd),
      },
      totals: {
        timesheetHours: Number(totalTimesheetHours.toFixed(2)),
        leaveHours: Number(totalLeaveHours.toFixed(2)),
      },
      days,
    };
  }

  private async countBackfilledDaysForMonth(
    userId: number,
    referenceDate: Date,
    now: Date
  ) {
    const db = this.database.connection;

    const startOfMonth = normalizeDate(
      new Date(
        Date.UTC(
          referenceDate.getUTCFullYear(),
          referenceDate.getUTCMonth(),
          1
        )
      )
    );
    const startOfNextMonth = normalizeDate(
      new Date(
        Date.UTC(
          referenceDate.getUTCFullYear(),
          referenceDate.getUTCMonth() + 1,
          1
        )
      )
    );

    const today = normalizeDate(now);
    const upperBound =
      today < startOfNextMonth ? today : startOfNextMonth;

    const [{ value: backfillCount }] = await db
      .select({ value: count(timesheetsTable.id) })
      .from(timesheetsTable)
      .where(
        and(
          eq(timesheetsTable.userId, userId),
          lt(timesheetsTable.workDate, upperBound),
          gte(timesheetsTable.workDate, startOfMonth)
        )
      );

    return Number(backfillCount ?? 0);
  }

  private normalizeDateUTC(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    );
  }

  private formatDateKey(date: Date): string {
    return this.normalizeDateUTC(date).toISOString().slice(0, 10);
  }

  private async getWorkingDayInfo(
    orgId: number,
    start: Date,
    end: Date
  ): Promise<
    Map<
      string,
      { isWorkingDay: boolean; isHoliday: boolean; isWeekend: boolean }
    >
  > {
    const normalizedStart = this.normalizeDateUTC(start);
    const normalizedEnd = this.normalizeDateUTC(end);

    if (normalizedEnd < normalizedStart) {
      return new Map();
    }

    const holidayMap = await this.calendarService.getHolidayMap(
      orgId,
      normalizedStart,
      normalizedEnd
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
}

