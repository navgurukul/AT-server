import { BadRequestException, Injectable } from "@nestjs/common";
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
} from "drizzle-orm";

import { DatabaseService } from "../../database/database.service";
import { timesheetEntriesTable, timesheetsTable } from "../../db/schema";
import { CalendarService } from "../calendar/calendar.service";
import { CreateTimesheetDto } from "./dto/create-timesheet.dto";

interface ListTimesheetParams {
  userId?: number;
  from?: string;
  to?: string;
  state?: string;
}

const MAX_BACKFILL_PER_MONTH = 3;

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
              taskDescription: timesheetEntriesTable.taskDescription,
              hoursDecimal: timesheetEntriesTable.hoursDecimal,
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

    const startOfCurrentMonth = normalizeDate(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    );
    const today = normalizeDate(now);
    const isBackfillThisMonth =
      workDate < today && workDate >= startOfCurrentMonth;

    if (workDate > today) {
      throw new BadRequestException("Cannot create timesheet for future date");
    }

    if (await this.calendarService.isHoliday(orgId, workDate)) {
      throw new BadRequestException(
        "Timesheets cannot be logged on holidays or non-working days"
      );
    }

    const currentBackfillUsage = await this.countBackfilledDaysForMonth(
      userId,
      now
    );

    if (workDate < startOfCurrentMonth || isBackfillThisMonth) {
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
          })
          .returning({ id: timesheetsTable.id });
        timesheetId = created.id;
      } else {
        timesheetId = existing.id;
        await tx
          .update(timesheetsTable)
          .set({
            notes: notesToPersist,
            updatedAt: now,
          })
          .where(eq(timesheetsTable.id, timesheetId));

        await tx
          .delete(timesheetEntriesTable)
          .where(eq(timesheetEntriesTable.timesheetId, timesheetId));
      }

      await tx.insert(timesheetEntriesTable).values(
        payload.entries.map((entry) => ({
          orgId,
          timesheetId,
          projectId: entry.projectId ?? null,
          taskDescription: entry.taskDescription ?? null,
          hoursDecimal: entry.hours.toString(),
          createdAt: now,
          updatedAt: now,
        }))
      );

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
          taskDescription: timesheetEntriesTable.taskDescription,
          hoursDecimal: timesheetEntriesTable.hoursDecimal,
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
      now
    );
    const backfillRemaining = Math.max(
      MAX_BACKFILL_PER_MONTH - usageAfterOperation,
      0
    );

    return {
      ...result.timesheet,
      entries: result.entries,
      backfillLimit: MAX_BACKFILL_PER_MONTH,
      backfillRemaining,
    };
  }

  private async countBackfilledDaysForMonth(userId: number, now: Date) {
    const db = this.database.connection;
    const startOfCurrentMonth = normalizeDate(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    );
    const today = normalizeDate(now);

    const [{ value: backfillCount }] = await db
      .select({ value: count(timesheetsTable.id) })
      .from(timesheetsTable)
      .where(
        and(
          eq(timesheetsTable.userId, userId),
          lt(timesheetsTable.workDate, today),
          gte(timesheetsTable.workDate, startOfCurrentMonth)
        )
      );

    return Number(backfillCount ?? 0);
  }
}
