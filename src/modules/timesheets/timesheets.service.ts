import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import { timesheetEntriesTable, timesheetsTable } from '../../db/schema';
import { CalendarService } from '../calendar/calendar.service';
import { CreateTimesheetDto } from './dto/create-timesheet.dto';
import { SubmitTimesheetDto } from './dto/submit-timesheet.dto';
import { UpsertTimesheetEntriesDto } from './dto/upsert-timesheet-entries.dto';

interface ListTimesheetParams {
  userId?: number;
  from?: string;
  to?: string;
  state?: string;
}

const MAX_BACKFILL_PER_MONTH = 3;

function normalizeDate(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

@Injectable()
export class TimesheetsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly calendarService: CalendarService,
  ) {}

  async listTimesheets(params: ListTimesheetParams) {
    const db = this.database.connection;

    const filters = [];
    if (params.userId) {
      filters.push(eq(timesheetsTable.userId, params.userId));
    }
    if (params.state) {
      const allowedStates = ['draft', 'submitted', 'approved', 'rejected', 'locked'] as const;
      if (allowedStates.includes(params.state as any)) {
        filters.push(eq(timesheetsTable.state, params.state as typeof allowedStates[number]));
      } else {
        throw new BadRequestException(`Invalid state: ${params.state}`);
      }
    }
    if (params.from) {
      filters.push(
        gte(timesheetsTable.workDate, normalizeDate(new Date(params.from))),
      );
    }
    if (params.to) {
      filters.push(
        lte(timesheetsTable.workDate, normalizeDate(new Date(params.to))),
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
      desc(timesheetsTable.id),
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
      {},
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
    orgId: number,
  ) {
    const db = this.database.connection;
    const workDate = normalizeDate(new Date(payload.workDate));
    const now = new Date();
    const startOfCurrentMonth = normalizeDate(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    );
    const today = normalizeDate(now);
    const isBackfillThisMonth =
      workDate < today && workDate >= startOfCurrentMonth;

    if (workDate > today) {
      throw new BadRequestException('Cannot create timesheet for future date');
    }

    if (await this.calendarService.isHoliday(orgId, workDate)) {
      throw new BadRequestException(
        'Timesheets cannot be logged on holidays or non-working days',
      );
    }

    const currentBackfillUsage = await this.countBackfilledDaysForMonth(
      userId,
      now,
    );

    if (workDate < startOfCurrentMonth || isBackfillThisMonth) {
      if (currentBackfillUsage >= MAX_BACKFILL_PER_MONTH) {
        throw new BadRequestException(
          `Backfilling is limited to ${MAX_BACKFILL_PER_MONTH} days per month`,
        );
      }
    }

    const [existing] = await db
      .select()
      .from(timesheetsTable)
      .where(
        and(
          eq(timesheetsTable.userId, userId),
          eq(timesheetsTable.workDate, workDate),
        ),
      )
      .limit(1);

    if (!existing) {
      const [created] = await db
        .insert(timesheetsTable)
        .values({
          orgId,
          userId,
          workDate,
          notes: payload.notes ?? null,
          state: 'draft',
          totalHours: '0',
        })
        .returning();

      const usageAfterInsert = await this.countBackfilledDaysForMonth(
        userId,
        now,
      );
      const backfillRemaining = Math.max(
        MAX_BACKFILL_PER_MONTH - usageAfterInsert,
        0,
      );

      return {
        ...created,
        backfillLimit: MAX_BACKFILL_PER_MONTH,
        backfillRemaining,
      };
    }

    if (existing.state === 'locked') {
      throw new BadRequestException('Locked timesheets cannot be updated');
    }

    const [updated] = await db
      .update(timesheetsTable)
      .set({
        notes: payload.notes ?? existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(timesheetsTable.id, existing.id))
      .returning();

    const usageAfterUpdate = await this.countBackfilledDaysForMonth(
      userId,
      now,
    );
    const backfillRemaining = Math.max(
      MAX_BACKFILL_PER_MONTH - usageAfterUpdate,
      0,
    );

    return {
      ...updated,
      backfillLimit: MAX_BACKFILL_PER_MONTH,
      backfillRemaining,
    };
  }

  async upsertEntries(
    timesheetId: number,
    payload: UpsertTimesheetEntriesDto,
  ) {
    const db = this.database.connection;

    return await db.transaction(async (tx) => {
      const [timesheet] = await tx
        .select()
        .from(timesheetsTable)
        .where(eq(timesheetsTable.id, timesheetId))
        .limit(1);

      if (!timesheet) {
        throw new NotFoundException(`Timesheet ${timesheetId} not found`);
      }

      if (['submitted', 'approved', 'locked'].includes(timesheet.state)) {
        throw new BadRequestException(
          `Cannot modify entries when timesheet is ${timesheet.state}`,
        );
      }

      if (payload.entries.length === 0) {
        throw new BadRequestException('At least one entry is required');
      }

      const entryIds = payload.entries
        .map((entry) => entry.id)
        .filter((id): id is number => !!id);

      if (entryIds.length > 0) {
        const existingEntries = await tx
          .select({
            id: timesheetEntriesTable.id,
            timesheetId: timesheetEntriesTable.timesheetId,
          })
          .from(timesheetEntriesTable)
          .where(inArray(timesheetEntriesTable.id, entryIds));

        const invalidIds = existingEntries.filter(
          (entry) => entry.timesheetId !== timesheetId,
        );
        if (invalidIds.length > 0) {
          throw new ForbiddenException('Entry does not belong to timesheet');
        }
      }

      const now = new Date();
      const rowsToInsert = payload.entries.filter((entry) => !entry.id);
      const rowsToUpdate = payload.entries.filter((entry) => !!entry.id);

      if (rowsToInsert.length > 0) {
        await tx.insert(timesheetEntriesTable).values(
          rowsToInsert.map((entry) => ({
            orgId: timesheet.orgId,
            timesheetId,
            projectId: entry.projectId ?? null,
            taskTitle: entry.taskTitle,
            taskDescription: entry.taskDescription ?? null,
            hoursDecimal: entry.hours.toString(),
            tags: entry.tags ?? [],
            createdAt: now,
            updatedAt: now,
          })),
        );
      }

      if (rowsToUpdate.length > 0) {
        for (const entry of rowsToUpdate) {
          await tx
            .update(timesheetEntriesTable)
            .set({
              projectId:
                entry.projectId === undefined
                  ? timesheetEntriesTable.projectId
                  : entry.projectId,
              taskTitle: entry.taskTitle,
              taskDescription: entry.taskDescription ?? null,
              hoursDecimal: entry.hours.toString(),
              tags: entry.tags ?? [],
              updatedAt: now,
            })
            .where(eq(timesheetEntriesTable.id, entry.id!));
        }
      }

      const [{ totalHours }] = await tx
        .select({
          totalHours: sql<number>`COALESCE(SUM(${timesheetEntriesTable.hoursDecimal}), 0)`,
        })
        .from(timesheetEntriesTable)
        .where(eq(timesheetEntriesTable.timesheetId, timesheetId));

      await tx
        .update(timesheetsTable)
        .set({
          totalHours: String(totalHours ?? 0),
          updatedAt: now,
        })
        .where(eq(timesheetsTable.id, timesheetId));

      const updatedEntries = await tx
        .select({
          id: timesheetEntriesTable.id,
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
        timesheetId,
        totalHours: Number(totalHours ?? 0),
        entries: updatedEntries,
      };
    });
  }

  async submitTimesheet(
    timesheetId: number,
    payload: SubmitTimesheetDto,
  ) {
    const db = this.database.connection;

    return await db.transaction(async (tx) => {
      const [timesheet] = await tx
        .select({
          id: timesheetsTable.id,
          userId: timesheetsTable.userId,
          orgId: timesheetsTable.orgId,
          state: timesheetsTable.state,
          totalHours: timesheetsTable.totalHours,
          workDate: timesheetsTable.workDate,
          notes: timesheetsTable.notes,
        })
        .from(timesheetsTable)
        .where(eq(timesheetsTable.id, timesheetId))
        .limit(1);

      if (!timesheet) {
        throw new NotFoundException(`Timesheet ${timesheetId} not found`);
      }

      if (!['draft', 'rejected'].includes(timesheet.state)) {
        throw new BadRequestException(
          `Timesheet in state '${timesheet.state}' cannot be submitted`,
        );
      }

      if (Number(timesheet.totalHours ?? 0) <= 0) {
        throw new BadRequestException(
          'Cannot submit an empty timesheet. Please add entries first.',
        );
      }

      const workDate = new Date(timesheet.workDate);
      const now = new Date();

      const maxFutureDate = new Date(now);
      maxFutureDate.setUTCDate(maxFutureDate.getUTCDate() + 1);
      if (workDate > maxFutureDate) {
        throw new BadRequestException(
          'Timesheets cannot be submitted more than one day in advance.',
        );
      }

      const nowDate = new Date();
      const [updated] = await tx
        .update(timesheetsTable)
        .set({
          state: 'approved',
          submittedAt: nowDate,
          approvedAt: nowDate,
          rejectedAt: null,
          notes: payload.note ?? timesheet.notes,
          updatedAt: nowDate,
        })
        .where(eq(timesheetsTable.id, timesheetId))
        .returning();

      return updated;
    });
  }

  private async countBackfilledDaysForMonth(userId: number, now: Date) {
    const db = this.database.connection;
    const startOfCurrentMonth = normalizeDate(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    );
    const today = normalizeDate(now);

    const [{ value: backfillCount }] = await db
      .select({ value: count(timesheetsTable.id) })
      .from(timesheetsTable)
      .where(
        and(
          eq(timesheetsTable.userId, userId),
          lt(timesheetsTable.workDate, today),
          gte(timesheetsTable.workDate, startOfCurrentMonth),
        ),
      );

    return Number(backfillCount ?? 0);
  }
}

