import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
  not,
  or,
  sql,
  SQL,
} from "drizzle-orm";

import { SalaryCycleUtil } from '../../common/utils/salary-cycle.util';
import { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { DatabaseService } from '../../database/database.service';
import { backfillCountersTable, backfillDatesTable, departmentsTable, leaveRequestsTable, leaveTypesTable, notificationsTable, payableDaysTable, projectsTable, rolesTable, timesheetEntriesTable, timesheetsTable, userRolesTable, usersTable } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { CalendarService } from '../calendar/calendar.service';
import { LeavesService } from '../leaves/leaves.service';
import { CreateTimesheetDto } from './dto/create-timesheet.dto';
import { CreateTimesheetAdminDto } from './dto/create-timesheet-admin.dto';

interface ListTimesheetParams {
  userId?: number;
  from?: string;
  to?: string;
  state?: string;
}

const DEFAULT_BACKFILL_PER_MONTH = 3;
const BACKFILL_CUTOFF_DAY = 25;
const MAX_HOURS_PER_DAY = 12;
const HALF_DAY_MAX_HOURS = 5.5;
const HOURS_PER_WORKING_DAY = 8;
const HALF_DAY_HOURS = HOURS_PER_WORKING_DAY / 2;

function normalizeDate(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

@Injectable()
export class TimesheetsService {
  private readonly logger = new Logger(TimesheetsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly calendarService: CalendarService,
    private readonly leavesService: LeavesService,
    private readonly auditService: AuditService,
  ) {}

  private async enforceLeaveBasedDailyHoursLimit(
    userId: number,
    workDate: Date,
    totalHoursForDay: number,
  ) {
    const db = this.database.connection;

    const leavesOnWorkDate = await db
      .select({
        durationType: leaveRequestsTable.durationType,
      })
      .from(leaveRequestsTable)
      .where(
        and(
          eq(leaveRequestsTable.userId, userId),
          or(
            eq(leaveRequestsTable.state, 'approved'),
            eq(leaveRequestsTable.state, 'pending'),
          ),
          lte(leaveRequestsTable.startDate, workDate),
          gte(leaveRequestsTable.endDate, workDate),
        ),
      );

    const hasFullDayLeave = leavesOnWorkDate.some(
      (leave) => leave.durationType === 'full_day',
    );
    if (hasFullDayLeave) {
      throw new BadRequestException(
        'You cannot submit a timesheet on a full-day leave.',
      );
    }

    const hasHalfDayLeave = leavesOnWorkDate.some(
      (leave) => leave.durationType === 'half_day',
    );
    if (hasHalfDayLeave && totalHoursForDay > HALF_DAY_MAX_HOURS) {
      throw new BadRequestException(
        `On a half-day leave, you cannot log more than ${HALF_DAY_MAX_HOURS} hours.`,
      );
    }
  }

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
            .where(
              and(
                inArray(timesheetEntriesTable.timesheetId, timesheetIds),
                eq(timesheetEntriesTable.status, 'approved'),
              ),
            )
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
    orgId: number,
    options?: {
      skipBackfillDeduction?: boolean;
      enforceCurrentSalaryCycle?: boolean;
    }
  ) {
    const db = this.database.connection;
    const workDate = normalizeDate(new Date(payload.workDate));
    const now = new Date();
    const skipBackfillDeduction = options?.skipBackfillDeduction ?? false;
    const enforceCurrentSalaryCycle = options?.enforceCurrentSalaryCycle ?? true;

    const [userInfo] = await db
      .select({
        name: usersTable.name,
        email: usersTable.email,
        slackId: usersTable.slackId,
        role: rolesTable.key,
      })
      .from(usersTable)
      .leftJoin(userRolesTable, eq(usersTable.id, userRolesTable.userId))
      .leftJoin(rolesTable, eq(userRolesTable.roleId, rolesTable.id))
      .where(eq(usersTable.id, userId))
      .limit(1);

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

      const taskDescription =
        entry.taskDescription && entry.taskDescription.trim().length > 0
          ? entry.taskDescription.trim()
          : null;

      if (taskDescription && taskDescription.length < 10) {
        throw new BadRequestException(
          `Entry ${index + 1} task description must be at least 10 characters long`
        );
      }

      const tags = Array.isArray(entry.tags)
        ? entry.tags.filter((tag) => typeof tag === "string" && tag.trim() !== "")
        : [];
      const hours = Number(entry.hours);
      if (Number.isNaN(hours) || hours <= 0) {
        throw new BadRequestException(
          `Entry ${index + 1} must include a valid positive number of hours`
        );
      }

      const key = projectId === null ? "__null__" : projectId.toString();
      const existing = normalizedEntriesMap.get(key);

      if (existing) {
        // Accumulate hours for the same project
        existing.hours += hours;
        // Merge tags
        existing.tags = Array.from(new Set([...existing.tags, ...tags]));
        // Merge descriptions: append new descriptions to existing ones
        if (taskDescription) {
          if (existing.taskDescription) {
            // Only add if not already present (case-insensitive)
            if (!existing.taskDescription.toLowerCase().includes(taskDescription.toLowerCase())) {
              existing.taskDescription = existing.taskDescription + ', ' + taskDescription;
            }
          } else {
            existing.taskDescription = taskDescription;
          }
        }
      } else {
        const normalized = {
          projectId,
          taskTitle,
          taskDescription: taskDescription,
          hours,
          tags,
        };
        normalizedEntriesMap.set(key, normalized);
      }
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

    let projectRecords:
      | Array<{
          id: number;
          orgId: number;
          slackChannelId: string | null;
          discordChannelId: string | null;
          name: string | null;
        }>
      | null = null;

    if (projectIds.length > 0) {
      projectRecords = await db
        .select({
          id: projectsTable.id,
          orgId: projectsTable.orgId,
          slackChannelId: projectsTable.slackChannelId,
          discordChannelId: projectsTable.discordChannelId,
          name: projectsTable.name,
        })
        .from(projectsTable)
        .where(inArray(projectsTable.id, projectIds));

      this.logger.log(`Fetched ${projectRecords.length} project records for IDs: ${projectIds.join(', ')}`);
      projectRecords.forEach(p => {
        this.logger.log(`  Project ${p.id} (${p.name}): slack=${p.slackChannelId ? 'SET' : 'null'}, discord=${p.discordChannelId ? 'SET' : 'null'}`);
      });

      const validProjectIds = new Set(
        projectRecords
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

    // Check if workDate is within the current salary cycle
    const currentCycle = SalaryCycleUtil.getCurrentSalaryCycle(now);
    const normalizedCycleStart = normalizeDate(currentCycle.start);
    const normalizedCycleEnd = normalizeDate(currentCycle.end);
    
    if (
      enforceCurrentSalaryCycle &&
      (workDate < normalizedCycleStart || workDate >= normalizedCycleEnd)
    ) {
      throw new BadRequestException(
        `Timesheets can only be filled for dates within the current salary cycle (${currentCycle.cycleLabel})`
      );
    }

    // Allow logging activities on non-working days (weekends, holidays) for comp-off generation
    // Removed validation that blocked timesheets on non-working days

    const isYesterday = today.getTime() - workDate.getTime() === 24 * 60 * 60 * 1000;
    const nowInIST = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const isBefore7AMIST = nowInIST.getHours() < 7;

    const isBackfill = workDate < today && !(isYesterday && isBefore7AMIST);

    if (isBackfill && userInfo.role !== 'super_admin' && userInfo.role !== 'admin') {
      const workingDaysPast = await this.calendarService.getWorkingDaysBetween(workDate, today);
      const ALLOWED_PAST_WORKING_DAYS = 5;
      if (workingDaysPast >= ALLOWED_PAST_WORKING_DAYS) {
        throw new BadRequestException(
          `Entry is too old. You can only fill timesheets for up to ${ALLOWED_PAST_WORKING_DAYS} past working days.`
        );
      }
    }
    
    const shouldApplyBackfillRules = enforceCurrentSalaryCycle;
    const backfillAllowance = shouldApplyBackfillRules && isBackfill
      ? await this.getBackfillAllowanceForCycle(orgId, userId, currentCycle, now)
      : { limit: DEFAULT_BACKFILL_PER_MONTH, used: 0, remaining: DEFAULT_BACKFILL_PER_MONTH };

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

    // Lifelines are available throughout the salary cycle, no cutoff date restriction
    // The restriction is only within the current salary cycle

    if (
      shouldApplyBackfillRules &&
      isBackfill &&
      !skipBackfillDeduction &&
      !existing &&
      backfillAllowance.remaining <= 0
    ) {
      throw new BadRequestException(
        `Backfilling (lifeline) is limited to ${backfillAllowance.limit} days per salary cycle. Lifelines reset on the 26th of each month at 7:01 AM.`
      );
    }

    if (
      existing &&
      ["submitted", "approved", "locked"].includes(existing.state)
    ) {
      throw new BadRequestException(
        `Cannot modify timesheet when it is ${existing.state}`
      );
    }

    // Fetch existing entries for this timesheet to merge/accumulate with new entries
    let entriesToSave = [...normalizedEntries];
    let finalTotalHoursForDay = totalHoursForDay;
    if (existing) {
      const existingEntries = await db
        .select({
          id: timesheetEntriesTable.id,
          projectId: timesheetEntriesTable.projectId,
          taskDescription: timesheetEntriesTable.taskDescription,
          hoursDecimal: timesheetEntriesTable.hoursDecimal,
          taskTitle: timesheetEntriesTable.taskTitle,
        })
        .from(timesheetEntriesTable)
        .where(
          and(
            eq(timesheetEntriesTable.timesheetId, existing.id),
            eq(timesheetEntriesTable.status, 'approved'),
          ),
        );

      // Create a map of existing entries by projectId for merging
      const existingByProjectId = new Map<number | null, typeof existingEntries[0]>();
      for (const entry of existingEntries) {
        const key = entry.projectId ?? null;
        existingByProjectId.set(key, entry);
      }

      // Merge new entries with existing ones - accumulate hours and descriptions
      entriesToSave = normalizedEntries.map((newEntry) => {
        const key = newEntry.projectId ?? null;
        const existing = existingByProjectId.get(key);

        if (existing) {
          // Accumulate hours
          const mergedHours = newEntry.hours + (Number(existing.hoursDecimal) || 0);
          
          // Merge descriptions: append new descriptions to existing ones
          let mergedDescription = existing.taskDescription || '';
          if (newEntry.taskDescription && mergedDescription) {
            // Only add if not already present (case-insensitive)
            if (!mergedDescription.toLowerCase().includes(newEntry.taskDescription.toLowerCase())) {
              mergedDescription = mergedDescription + ', ' + newEntry.taskDescription;
            }
          } else if (newEntry.taskDescription) {
            mergedDescription = newEntry.taskDescription;
          }

          return {
            ...newEntry,
            hours: mergedHours,
            taskDescription: mergedDescription || null,
          };
        }
        return newEntry;
      });

      // Validate final total hours for the day after applying this partial update.
      // Existing entries for projects not included in the payload remain unchanged,
      // so include them in the total check as well.
      const updatedProjectIds = new Set<number>(
        normalizedEntries
          .map((entry) => entry.projectId)
          .filter((id): id is number => id !== null),
      );
      const updatesNullProject = normalizedEntries.some(
        (entry) => entry.projectId === null,
      );

      const untouchedExistingHours = existingEntries.reduce((acc, entry) => {
        const isNullProject = entry.projectId === null;
        const existingProjectId = entry.projectId;
        const isUpdatedProject = isNullProject
          ? updatesNullProject
          : existingProjectId !== null && updatedProjectIds.has(existingProjectId);

        if (isUpdatedProject) {
          return acc;
        }

        return acc + (Number(entry.hoursDecimal) || 0);
      }, 0);

      const combinedHours =
        untouchedExistingHours +
        entriesToSave.reduce((acc, entry) => acc + entry.hours, 0);
      if (combinedHours > MAX_HOURS_PER_DAY) {
        throw new BadRequestException(
          `Timesheet hours cannot exceed ${MAX_HOURS_PER_DAY} hours per day (total: ${combinedHours}h)`
        );
      }

      finalTotalHoursForDay = combinedHours;
    }

    await this.enforceLeaveBasedDailyHoursLimit(
      userId,
      workDate,
      finalTotalHoursForDay,
    );

    const notesToPersist = payload.notes ?? existing?.notes ?? null;

    const result = await db.transaction(async (tx) => {
      let timesheetId: number;
      const isNewTimesheet = !existing;

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

      let projectChannelMap: Record<
        number,
        { channel: string | null; discordWebhook: string | null; name: string | null }
      > = {};

      if (entriesToSave.length > 0) {
        // Delete only entries for projects being updated (to allow accumulated additions)
        const projectIdsToUpdate = Array.from(
          new Set(
            entriesToSave
              .map((entry) => entry.projectId)
              .filter((id): id is number => id !== null)
          )
        );
        const includesNullProject = entriesToSave.some(
          (entry) => entry.projectId === null
        );

        if (projectIdsToUpdate.length > 0 || includesNullProject) {
          const deleteConditions = [];
          if (projectIdsToUpdate.length > 0) {
            deleteConditions.push(
              inArray(timesheetEntriesTable.projectId, projectIdsToUpdate)
            );
          }
          if (includesNullProject) {
            deleteConditions.push(isNull(timesheetEntriesTable.projectId));
          }

          await tx
            .delete(timesheetEntriesTable)
            .where(
              and(
                eq(timesheetEntriesTable.timesheetId, timesheetId),
                deleteConditions.length === 1
                  ? deleteConditions[0]
                  : or(...deleteConditions)
              )
            );
        }

        if (projectRecords) {
          projectChannelMap = projectRecords.reduce<Record<number, { channel: string | null; discordWebhook: string | null; name: string | null }>>(
            (acc, project) => {
              acc[Number(project.id)] = {
                channel: project.slackChannelId ?? null,
                discordWebhook: project.discordChannelId ?? null,
                name: project.name ?? null,
              };
              return acc;
            },
            {},
          );
        }

        await tx.insert(timesheetEntriesTable).values(
          entriesToSave.map((entry) => ({
            orgId,
            timesheetId,
            projectId: entry.projectId,
            taskTitle: entry.taskTitle,
            taskDescription: entry.taskDescription ?? null,
            hoursDecimal: entry.hours.toString(),
            tags: entry.tags ?? [],
            status: 'approved',
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
        .where(
          and(
            eq(timesheetEntriesTable.timesheetId, timesheetId),
            eq(timesheetEntriesTable.status, 'approved'),
          ),
        );

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
        .where(
          and(
            eq(timesheetEntriesTable.timesheetId, timesheetId),
            eq(timesheetEntriesTable.status, 'approved'),
          ),
        )
        .orderBy(asc(timesheetEntriesTable.id));

      // If this is a new backfill entry, increment usage counters for the salary cycle.
      if (shouldApplyBackfillRules && isBackfill && isNewTimesheet && !skipBackfillDeduction) {
        await this.incrementBackfillUsageForCycle(tx, orgId, userId, currentCycle, workDate, now);
      }

      return {
        timesheet: storedTimesheet,
        entries: savedEntries,
        projectChannelMap,
      };
    });

    const backfillRemaining = shouldApplyBackfillRules && isBackfill
      ? skipBackfillDeduction
        ? backfillAllowance.remaining
        : Math.max(backfillAllowance.remaining - (existing ? 0 : 1), 0)
      : backfillAllowance.remaining;
// Try to automatically process comp off for this timesheet
    // This happens after the transaction to avoid any conflicts
    try {
      const totalHoursNum = Number(result.timesheet.totalHours ?? 0);
      if (totalHoursNum > 0) {
        await this.leavesService.tryProcessCompOffForTimesheet(
          orgId,
          userId,
          workDate,
          result.timesheet.id,
          totalHoursNum
        );
      }
    } catch (error) {
      // If comp off processing fails, just log it
      // The comp off can be processed manually later or retried
      this.logger.warn(
        `Failed to auto-process comp off for timesheet ${result.timesheet.id}:`,
        error
      );
    }

    // 
    // Send Slack notifications per project channel
    const entriesByProject = result.entries.reduce<
      Record<
        number,
        {
          hours: number;
          descriptions: string[];
        }
      >
    >((acc, entry) => {
      if (entry.projectId !== null && entry.projectId !== undefined) {
        const pid = Number(entry.projectId);
        const hoursVal = Number(entry.hoursDecimal ?? 0);
        if (!acc[pid]) {
          acc[pid] = { hours: 0, descriptions: [] };
        }
        acc[pid].hours += hoursVal;
        const desc = entry.taskDescription || entry.taskTitle;
        if (desc && desc.trim().length > 0) {
          acc[pid].descriptions.push(desc.trim());
        }
      }
      return acc;
    }, {});

    // Send notifications for each project
    this.logger.log(`Processing notifications for ${Object.keys(entriesByProject).length} projects`);
    for (const [pidStr, data] of Object.entries(entriesByProject)) {
      const pid = Number(pidStr);
      const projectMeta = result.projectChannelMap?.[pid];
      const channel = projectMeta?.channel ?? null;
      const discordWebhook = projectMeta?.discordWebhook ?? null;
      
      this.logger.log(`Project ${pid} (${projectMeta?.name}): Slack=${!!channel}, Discord=${!!discordWebhook}`);
      
      const notificationPayload = {
        userId,
        userName: userInfo?.name ?? `User ${userId}`,
        userEmail: userInfo?.email ?? null,
        userSlackId: userInfo?.slackId ?? null,
        workDate,
        workDateFormatted: this.formatDateDDMMYYYY(workDate),
        projectId: pid,
        projectName: projectMeta?.name ?? null,
        hours: data.hours,
        description: data.descriptions.join("; "),
      };

      // Send Slack notification if configured
      if (channel) {
        this.logger.debug(`Enqueueing Slack notification for project ${projectMeta?.name} (ID: ${pid})`);
        await this.enqueueSlackNotification(orgId, channel, 'timesheet_entry', notificationPayload);
      }

      // Send Discord notification if configured
      if (discordWebhook) {
        this.logger.debug(`Enqueueing Discord notification for project ${projectMeta?.name} (ID: ${pid})`);
        await this.enqueueDiscordNotification(orgId, discordWebhook, 'timesheet_entry', notificationPayload);
      }
    }

    const cycleRange = this.getCycleRangeForWorkDate(workDate);
    await this.recalculateAndPersistPayableDaysForCycle(
      db,
      orgId,
      userId,
      cycleRange.cycleStart,
      cycleRange.cycleEnd,
      cycleRange.cycleKey,
      now,
    );

    return {
      ...result.timesheet,
      entries: result.entries,
      backfillLimit: backfillAllowance.limit,
      backfillRemaining,
    };
  }

  private getPayableDaysForHours(hours: number): number {
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

    const workingDayInfo = await this.getWorkingDayInfo(
      orgId,
      cycleStartDate,
      cycleEndDate,
    );

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
        if (!workingDayInfo.get(key)?.isWorkingDay) {
          weekOffDays += 1;
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    let totalHours = 0;
    let totalWorkingDays = 0;
    let totalPayableDaysFromLeaves = 0;

    for (const timesheet of cycleTimesheets) {
      const workDateKey = this.formatDateKey(new Date(timesheet.workDate));
      const dayInfo = workingDayInfo.get(workDateKey);

      // Only working-day entries count toward payable days.
      if (!dayInfo?.isWorkingDay) {
        continue;
      }

      const hours = Number(timesheet.totalHours ?? 0);
      if (!Number.isFinite(hours)) {
        continue;
      }
      totalHours += hours;
      totalWorkingDays += this.getPayableDaysForHours(hours);
    }

    for (const leave of approvedLeaves) {
      const leaveTypeCode = (leave.leaveTypeCode ?? '').toLowerCase();
      const leaveTypeName = (leave.leaveTypeName ?? '').toLowerCase();
      const isLwp =
        leaveTypeCode === 'lwp' ||
        leaveTypeName.includes('without pay') ||
        leaveTypeName.includes('lwp');

      // LWP is approved leave but should not be counted as payable.
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

      const applicableWorkingDayKeys: string[] = [];
      const cursor = new Date(windowStart);
      while (cursor <= windowEnd) {
        const key = this.formatDateKey(cursor);
        if (workingDayInfo.get(key)?.isWorkingDay) {
          applicableWorkingDayKeys.push(key);
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      if (applicableWorkingDayKeys.length === 0) {
        continue;
      }

      const durationType = (leave.durationType ?? 'full_day').toLowerCase();
      const leavePayablePerDay = durationType === 'half_day' ? 0.5 : 1;

      totalPayableDaysFromLeaves += applicableWorkingDayKeys.length * leavePayablePerDay;
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

  async createOrUpsertByAdmin(
    payload: CreateTimesheetAdminDto,
    adminId: number,
    orgId: number,
    actorRoles: string[] = [],
  ) {
    const db = this.database.connection;

    // Verify that the target user exists and belongs to the same organization
    const [targetUser] = await db
      .select({
        id: usersTable.id,
        orgId: usersTable.orgId,
        status: usersTable.status,
        name: usersTable.name,
      })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.id, payload.userId),
          eq(usersTable.orgId, orgId)
        )
      )
      .limit(1);

    if (!targetUser) {
      throw new NotFoundException(
        `User with ID ${payload.userId} not found in your organization`
      );
    }

    // Convert admin DTO to standard DTO by creating it without the userId
    const timesheetDto: CreateTimesheetDto = {
      workDate: payload.workDate,
      notes: payload.notes,
      entries: payload.entries,
    };

    // Call the existing createOrUpsert method with the target user ID
    const result = await this.createOrUpsert(timesheetDto, payload.userId, orgId, {
      skipBackfillDeduction: true,
      enforceCurrentSalaryCycle: false,
    });

    const actorRole = this.getPrivilegedActorRole(actorRoles);
    if (actorRole) {
      await this.auditService.createLog({
        orgId,
        actorUserId: adminId,
        actorRole,
        action: 'timesheet_created',
        subjectType: 'timesheet_created',
        targetUserId: payload.userId,
        next: {
          workDate: payload.workDate,
          notes: payload.notes ?? null,
          entriesCount: payload.entries.length,
        },
      });
    }

    return result;
  }

  async recalculatePayableDaysForUserByExistingCycles(
    orgId: number,
    userId: number,
  ): Promise<number> {
    const db = this.database.connection;
    const now = new Date();

    const rows = await db
      .select({ cycle: payableDaysTable.cycle })
      .from(payableDaysTable)
      .where(eq(payableDaysTable.userId, userId));

    const uniqueCycleKeys = Array.from(
      new Set(rows.map((row) => this.formatDateKey(new Date(row.cycle)))),
    );

    const currentCycle = SalaryCycleUtil.getCurrentSalaryCycle(now);
    const currentCycleEnd = this.normalizeDateUTC(
      new Date(
        Date.UTC(
          currentCycle.end.getUTCFullYear(),
          currentCycle.end.getUTCMonth(),
          25,
        ),
      ),
    );
    const currentCycleKey = this.formatDateKey(currentCycleEnd);
    if (!uniqueCycleKeys.includes(currentCycleKey)) {
      uniqueCycleKeys.push(currentCycleKey);
    }

    for (const cycleKey of uniqueCycleKeys) {
      const cycleDate = new Date(`${cycleKey}T00:00:00.000Z`);
      const cycleRange = this.getCycleRangeForWorkDate(cycleDate);
      await this.recalculateAndPersistPayableDaysForCycle(
        db,
        orgId,
        userId,
        cycleRange.cycleStart,
        cycleRange.cycleEnd,
        cycleRange.cycleKey,
        now,
      );
    }

    return uniqueCycleKeys.length;
  }

  async updateBackfillLimit(payload: {
    orgId: number;
    userId: number;
    year: number;
    month: number;
    limit: number;
    actor?: AuthenticatedUser;
  }) {
    const { orgId, userId, year, month, limit, actor } = payload;
    const db = this.database.connection;
    const now = new Date();

    const [counter] = await db
      .select({
        id: backfillCountersTable.id,
        used: backfillCountersTable.used,
        limit: backfillCountersTable.limit,
      })
      .from(backfillCountersTable)
      .where(
        and(
          eq(backfillCountersTable.orgId, orgId),
          eq(backfillCountersTable.userId, userId),
          eq(backfillCountersTable.year, year),
          eq(backfillCountersTable.month, month)
        )
      )
      .limit(1);

    let used = counter ? Number(counter.used ?? 0) : 0;
    const previousLimit = counter ? Number(counter.limit ?? DEFAULT_BACKFILL_PER_MONTH) : null;

    if (!counter) {
      used = await this.countBackfilledDaysForMonth(
        orgId,
        userId,
        new Date(Date.UTC(year, month - 1, 1)),
        now
      );

      await db
        .insert(backfillCountersTable)
        .values({
          orgId,
          userId,
          year,
          month,
          used,
          limit,
          lastUsedAt: null,
        })
        .onConflictDoUpdate({
          target: [
            backfillCountersTable.orgId,
            backfillCountersTable.userId,
            backfillCountersTable.year,
            backfillCountersTable.month,
          ],
          set: {
            used,
            limit,
            lastUsedAt: now,
          },
        });
    } else {
      await db
        .update(backfillCountersTable)
        .set({
          limit,
          lastUsedAt: now,
        })
        .where(eq(backfillCountersTable.id, counter.id));
    }

    const actorRole = this.getPrivilegedActorRole(actor?.roles ?? []);
    if (actorRole) {
      await this.auditService.createLog({
        orgId,
        actorUserId: actor?.id,
        actorRole,
        action: 'Lifelines_Edited',
        subjectType: 'Lifelines_Edited',
        targetUserId: userId,
        prev: {
          userId,
          year,
          month,
          used,
          limit: previousLimit,
        },
        next: {
          userId,
          year,
          month,
          used,
          limit,
        },
      });
    }

    return {
      userId,
      orgId,
      year,
      month,
      used,
      limit,
      remaining: Math.max(limit - used, 0),
    };
  }

  async getCurrentCycleBackfill(params: { orgId: number; userId: number }) {
    const { orgId, userId } = params;
    const now = new Date();
    const cycle = SalaryCycleUtil.getCurrentSalaryCycle(now);
    const { year, month } = cycle;
    const db = this.database.connection;

    const [counter] = await db
      .select({
        used: backfillCountersTable.used,
        limit: backfillCountersTable.limit,
      })
      .from(backfillCountersTable)
      .where(
        and(
          eq(backfillCountersTable.orgId, orgId),
          eq(backfillCountersTable.userId, userId),
          eq(backfillCountersTable.year, year),
          eq(backfillCountersTable.month, month),
        ),
      )
      .limit(1);

    const usage =
      counter && counter.used !== null && counter.used !== undefined
        ? Number(counter.used)
        : await this.countBackfilledDaysForCycle(
            orgId,
            userId,
            cycle,
            now,
          );

    const limit =
      counter && counter.limit !== null && counter.limit !== undefined
        ? Number(counter.limit)
        : DEFAULT_BACKFILL_PER_MONTH;

    return {
      limit,
      remaining: Math.max(limit - usage, 0),
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

    // Use salary cycle instead of calendar month
    // month parameter now represents the salary cycle starting month
    const cycleRange = SalaryCycleUtil.getSalaryCycleDateRange(year, month);
    const monthStart = cycleRange.start; // 26th of the month
    const monthEnd = cycleRange.end; // 25th of next month (payable day period)
    const nextMonthStart = new Date(monthEnd);
    nextMonthStart.setUTCDate(nextMonthStart.getUTCDate() + 1);
    const cycleKey = this.formatDateKey(monthEnd);

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

    const [payableDaysRow] = await db
      .select({
        totalHours: payableDaysTable.totalHours,
        totalWorkingDays: payableDaysTable.totalWorkingDays,
        weekOff: payableDaysTable.weekOff,
        totalPayableDays: payableDaysTable.totalPayableDays,
      })
      .from(payableDaysTable)
      .where(
        and(
          eq(payableDaysTable.userId, userId),
          eq(payableDaysTable.cycle, cycleKey),
        ),
      )
      .orderBy(desc(payableDaysTable.id))
      .limit(1);

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
              status: timesheetEntriesTable.status,
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
            .where(
              and(
                inArray(timesheetEntriesTable.timesheetId, timesheetIds),
                or(
                  eq(timesheetEntriesTable.status, 'approved'),
                  isNull(timesheetEntriesTable.status),
                ),
              ),
            )
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
      if (entry.status === 'rejected') {
        continue;
      }

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
      const approvedEntries = entriesByTimesheet.get(row.id) ?? [];
      timesheetMap.set(key, {
        id: row.id,
        state: row.state,
        totalHours: approvedEntries.reduce((sum, item) => sum + (item.hours ?? 0), 0),
        notes: row.notes ?? null,
        submittedAt: row.submittedAt ? new Date(row.submittedAt) : null,
        approvedAt: row.approvedAt ? new Date(row.approvedAt) : null,
        rejectedAt: row.rejectedAt ? new Date(row.rejectedAt) : null,
        lockedAt: row.lockedAt ? new Date(row.lockedAt) : null,
        createdAt: row.createdAt ? new Date(row.createdAt) : null,
        updatedAt: row.updatedAt ? new Date(row.updatedAt) : null,
        entries: approvedEntries,
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
        reason: leaveRequestsTable.reason,
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
          reason: string | null;
          leaveType: {
            id: number;
            code: string | null;
            name: string | null;
          };
        }>;
      }
    >();

    let totalLeaveHours = 0;
    let totalWorkingDays = 0;
    let paidLeaves = 0;
    let totalCompOffLeaveTaken = 0;
    let weekOffDays = 0;
    let numOfWorkOnWeekendDays = 0;
    let lwpDays = 0;
    let totalPayableDaysFromTimesheets = 0; // Track payable days based on hours worked

    const timesheetDates = new Set<string>();
    const leaveDates = new Map<string, { isLWP: boolean; isCompOff: boolean; isPaid: boolean }>();

    // Process all leave requests to include them in the response
    // But only count approved leaves towards payable days
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
      const totalRequestHours =
        requestHours > 0
          ? requestHours
          : request.durationType === 'half_day'
            ? dayKeys.length * HALF_DAY_HOURS
            : dayKeys.length * HOURS_PER_WORKING_DAY;
      const perDayHours = dayKeys.length === 0 ? 0 : totalRequestHours / dayKeys.length;

      // Determine leave type for day counting
      const isLWP = request.leaveTypeCode === 'lwp' || 
                    request.leaveTypeName?.toLowerCase().includes('without pay');
      const isCompOff = request.leaveTypeCode === 'comp_off' || 
                       request.leaveTypeName?.toLowerCase().includes('comp off');
      const isPaidLeave = !isLWP && !isCompOff;

      // Count leave days based on actual hours, not just day count
      // Full day = 8 hours, Half day = 4 hours
      const isApproved = request.state === 'approved';
      const leaveDaysCount =
        requestHours > 0
          ? requestHours / HOURS_PER_WORKING_DAY
          : request.durationType === 'half_day'
            ? dayKeys.length * 0.5
            : dayKeys.length;

      // Only count approved leaves towards payable days
      if (isApproved) {
        if (isLWP) {
          lwpDays += leaveDaysCount;
        } else if (isCompOff) {
          totalCompOffLeaveTaken += leaveDaysCount;
        } else if (isPaidLeave) {
          paidLeaves += leaveDaysCount;
        }
      }

      for (const key of dayKeys) {
        const hoursForDay = perDayHours;

        if (hoursForDay <= 0) {
          continue;
        }

        // Only add to totalLeaveHours if the leave is approved
        if (isApproved) {
          totalLeaveHours += hoursForDay;
        }

        // Mark these dates as leave (only for approved leaves)
        if (isApproved) {
          leaveDates.set(key, { isLWP, isCompOff, isPaid: isPaidLeave });
        }

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
              reason: string | null;
              leaveType: {
                id: number;
                code: string | null;
                name: string | null;
              };
            }>;
          });

        // Only add hours to bucket total for approved leaves
        if (isApproved) {
          bucket.totalHours += hoursForDay;
        }
        
        // Always add the entry to show in response (including pending/rejected)
        bucket.entries.push({
          requestId: request.id,
          state: request.state,
          durationType: request.durationType,
          halfDaySegment: request.halfDaySegment ?? null,
          hours: request.durationType === 'half_day' ? HALF_DAY_HOURS : HOURS_PER_WORKING_DAY,
          reason: request.reason ?? null,
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

    // Process timesheets to count working days and weekend work, and calculate payable days based on hours
    for (const timesheet of timesheets) {
      const workDate = this.normalizeDateUTC(new Date(timesheet.workDate));
      const key = this.formatDateKey(workDate);
      const hours = timesheet.totalHours ? Number(timesheet.totalHours) : 0;
      
      timesheetDates.add(key);

      // Calculate payable days based on hours worked
      if (hours < 3) {
        // Less than 3 hours: not counted as payable day (0)
        totalPayableDaysFromTimesheets += 0;
      } else if (hours < 6) {
        // 3 to less than 6 hours: half day (0.5)
        totalPayableDaysFromTimesheets += 0.5;
      } else {
        // 6 or more hours: full day (1)
        totalPayableDaysFromTimesheets += 1;
      }

      const info = workingDayInfo.get(key);
      if (info?.isWorkingDay) {
        if (hours < 3) {
          totalWorkingDays += 0;
        } else if (hours < 6) {
          totalWorkingDays += 0.5;
        } else {
          totalWorkingDays += 1;
        }
      } else if (info?.isWeekend || info?.isHoliday) {
        // Work on weekend/holiday
        numOfWorkOnWeekendDays += 1;
      }
    }

    // Count week-off days in the cycle (weekends and holidays that are not working days)
    const cursorForWeekOff = new Date(monthStart);
    while (cursorForWeekOff <= monthEnd) {
      const key = this.formatDateKey(cursorForWeekOff);
      const info = workingDayInfo.get(key);
      
      // Count non-working days (weekends/holidays) that don't have timesheet entries
      if (!info?.isWorkingDay && !timesheetDates.has(key)) {
        weekOffDays += 1;
      }
      
      cursorForWeekOff.setUTCDate(cursorForWeekOff.getUTCDate() + 1);
    }

    // Calculate total payable days using new logic: week off days + payable days from timesheets (based on hours) + paid leaves + comp-off - LWP
    const totalPayableDays = weekOffDays + totalPayableDaysFromTimesheets + paidLeaves + totalCompOffLeaveTaken - lwpDays;
    const parseNumeric = (value: unknown) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const totalHoursFromPayableDays = parseNumeric(payableDaysRow?.totalHours);
    const totalWorkingDaysFromPayableDays = parseNumeric(
      payableDaysRow?.totalWorkingDays,
    );
    const weekOffDaysFromPayableDays = parseNumeric(payableDaysRow?.weekOff);
    const totalPayableDaysFromPayableDays = parseNumeric(
      payableDaysRow?.totalPayableDays,
    );

    const days: Array<{
      date: string;
      isWorkingDay: boolean;
      isWeekend: boolean;
      isHoliday: boolean;
      holidayName: string | null;
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
        holidayName: info?.holidayName ?? null,
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

    // Get salary cycle label for display
    const cycleInfo = SalaryCycleUtil.getSalaryCycleForMonth(year, month);

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
        cycleLabel: cycleInfo.cycleLabel, // e.g., "26 Jan 2026 - 25 Feb 2026"
        isSalaryCycle: true,
      },
      totals: {
        totalHours: totalHoursFromPayableDays,
        totalWorkingDays: totalWorkingDaysFromPayableDays,
        paidLeaves,
        totalCompOffLeaveTaken,
        weekOffDays: weekOffDaysFromPayableDays,
        numOfWorkOnWeekendDays,
        totalPayableDays: totalPayableDaysFromPayableDays,
        LWP: lwpDays,
        timesheetHours: Number(totalTimesheetHours.toFixed(2)),
        leaveHours: Number(totalLeaveHours.toFixed(2)),
      },
      days,
    };
  }

  async getSalarySummary(params: {
    userId: number;
    orgId: number;
    startDate: string;
    endDate: string;
  }) {
    const { userId, orgId, startDate, endDate } = params;

    // Parse and validate dates
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('startDate and endDate must be valid ISO dates (YYYY-MM-DD)');
    }

    if (end < start) {
      throw new BadRequestException('endDate must be greater than or equal to startDate');
    }

    // Normalize dates to UTC
    const monthStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    const monthEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));

    // Store the display dates
    const displayStartDate = new Date(monthStart);
    const displayEndDate = new Date(monthEnd);

    const db = this.database.connection;

    // Calculate the next day after end for query purposes
    const nextDayStart = new Date(monthEnd);
    nextDayStart.setUTCDate(nextDayStart.getUTCDate() + 1);
    const [user] = await db
      .select({
        id: usersTable.id,
        orgId: usersTable.orgId,
        name: usersTable.name,
        email: usersTable.email,
        employmentType: usersTable.employmentType,
        employmentStatus: usersTable.employmentStatus,
        employeeDepartmentId: usersTable.employeeDepartmentId,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user || Number(user.orgId) !== orgId) {
      throw new NotFoundException('User not found for this organisation');
    }

    // Get employee department name for teamName
    let teamName = 'Not specified';
    if (user.employeeDepartmentId) {
      const [dept] = await db
        .select({ name: departmentsTable.name })
        .from(departmentsTable)
        .where(eq(departmentsTable.id, user.employeeDepartmentId))
        .limit(1);
      if (dept) {
        teamName = dept.name;
      }
    }

    // Get timesheets for the cycle
    const timesheets = await db
      .select({
        id: timesheetsTable.id,
        workDate: timesheetsTable.workDate,
        totalHours: timesheetsTable.totalHours,
        state: timesheetsTable.state,
      })
      .from(timesheetsTable)
      .where(
        and(
          eq(timesheetsTable.userId, userId),
          eq(timesheetsTable.orgId, orgId),
          gte(timesheetsTable.workDate, monthStart),
          lt(timesheetsTable.workDate, nextDayStart),
        ),
      )
      .orderBy(asc(timesheetsTable.workDate));

    // Get leave requests for the cycle
    const leaveRequests = await db
      .select({
        id: leaveRequestsTable.id,
        startDate: leaveRequestsTable.startDate,
        endDate: leaveRequestsTable.endDate,
        hours: leaveRequestsTable.hours,
        state: leaveRequestsTable.state,
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
          lte(leaveRequestsTable.startDate, nextDayStart),
          gte(leaveRequestsTable.endDate, monthStart),
        ),
      );

    // Get working day info for the cycle
    const workingDayInfo = await this.getWorkingDayInfo(orgId, monthStart, monthEnd);

    // Calculate metrics
    let totalHours = 0;
    let totalWorkingDays = 0;
    let paidLeaves = 0;
    let earnLeave = 0;
    let specialLeave = 0;
    let totalCompOffLeaveTaken = 0;
    let weekOffDays = 0;
    let numOfWorkOnWeekendDays = 0;
    let lwpDays = 0;
    let totalLeaveHours = 0;
    let totalPayableDaysFromTimesheets = 0; // Track payable days based on hours worked

    const timesheetDates = new Set<string>();

    // Process timesheets - calculate payable days based on hours worked
    for (const timesheet of timesheets) {
      const workDate = this.normalizeDateUTC(new Date(timesheet.workDate));
      const key = this.formatDateKey(workDate);
      const hours = timesheet.totalHours ? Number(timesheet.totalHours) : 0;
      
      timesheetDates.add(key);
      totalHours += hours;

      // Calculate payable days based on hours worked
      if (hours < 3) {
        // Less than 3 hours: not counted as payable day (0)
        totalPayableDaysFromTimesheets += 0;
      } else if (hours < 6) {
        // 3 to less than 6 hours: half day (0.5)
        totalPayableDaysFromTimesheets += 0.5;
      } else {
        // 6 or more hours: full day (1)
        totalPayableDaysFromTimesheets += 1;
      }

      const info = workingDayInfo.get(key);
      if (info?.isWorkingDay) {
        if (hours < 3) {
          totalWorkingDays += 0;
        } else if (hours < 6) {
          totalWorkingDays += 0.5;
        } else {
          totalWorkingDays += 1;
        }
      } else if (info?.isWeekend || info?.isHoliday) {
        // Work on weekend/holiday
        numOfWorkOnWeekendDays += 1;
      }
    }

    // Process leave requests
    const leaveDates = new Map<string, { isLWP: boolean; isCompOff: boolean; isPaid: boolean }>();
    
    for (const request of leaveRequests) {
      const requestStart = this.normalizeDateUTC(new Date(request.startDate));
      const requestEnd = this.normalizeDateUTC(new Date(request.endDate));
      const requestHours = request.hours ? Number(request.hours) : 0;

      const windowStart = requestStart > monthStart ? requestStart : monthStart;
      const windowEnd = requestEnd < monthEnd ? requestEnd : monthEnd;

      if (windowEnd < windowStart) {
        continue;
      }

      // Collect working days in this leave request
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

      // Determine leave type
      const isLWP = request.leaveTypeCode === 'lwp' || 
                    request.leaveTypeName?.toLowerCase().includes('without pay');
      const isCompOff = request.leaveTypeCode === 'comp_off' || 
                       request.leaveTypeName?.toLowerCase().includes('comp off');
      const isPaidLeave = !isLWP && !isCompOff;

      // Count leave days based on leave hours (8h = 1 day, 4h = 0.5 day)
      // Fallback to durationType/day count when hours are missing
      let leaveDaysCount = 0;
      if (requestHours > 0) {
        leaveDaysCount = requestHours / HOURS_PER_WORKING_DAY;
      } else if (request.durationType === 'half_day') {
        leaveDaysCount = dayKeys.length * 0.5;
      } else {
        leaveDaysCount = dayKeys.length;
      }

      if (isLWP) {
        lwpDays += leaveDaysCount;
      } else if (isCompOff) {
        totalCompOffLeaveTaken += leaveDaysCount;
      } else if (isPaidLeave) {
        paidLeaves += leaveDaysCount;
        if (this.isEarnLeaveType(request.leaveTypeCode, request.leaveTypeName)) {
          earnLeave += leaveDaysCount;
        } else {
          specialLeave += leaveDaysCount;
        }
      }

      // Calculate leave hours for this request
      if (requestHours > 0) {
        totalLeaveHours += requestHours;
      } else if (request.durationType === 'half_day') {
        totalLeaveHours += dayKeys.length * HALF_DAY_HOURS;
      } else {
        totalLeaveHours += dayKeys.length * HOURS_PER_WORKING_DAY;
      }

      // Mark these dates as leave
      for (const key of dayKeys) {
        leaveDates.set(key, { isLWP, isCompOff, isPaid: isPaidLeave });
      }
    }

    // Count week-off days in the cycle (weekends and holidays that are not working days)
    const cursor = new Date(monthStart);
    while (cursor <= monthEnd) {
      const key = this.formatDateKey(cursor);
      const info = workingDayInfo.get(key);
      
      // Count non-working days (weekends/holidays) that don't have timesheet entries
      if (!info?.isWorkingDay && !timesheetDates.has(key)) {
        weekOffDays += 1;
      }
      
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    // Calculate total payable days
    // Week off days are automatically payable + payable days from timesheets (based on hours) + paid leaves + comp-off - LWP
    const totalPayableDays = weekOffDays + totalPayableDaysFromTimesheets + paidLeaves + totalCompOffLeaveTaken - lwpDays;

    // Calculate LWP (Leave Without Pay) - days not paid
    const LWP = lwpDays;

    return {
      email: user.email,
      name: user.name,
      employmentType: user.employmentType || 'Not specified',
      status: user.employmentStatus || 'not specified',
      teamName,

      cycleStartDate: displayStartDate.toISOString(),
      cycleEndDate: displayEndDate.toISOString(),

      totalHours,
      totalWorkingDays,
      paidLeaves,
      earnLeave,
      specialLeave,
      totalCompOffLeaveTaken,
      weekOffDays,
      numOfWorkOnWeekendDays,

      totalPayableDays,
      LWP,
      
      totals: {
        timesheetHours: Number(totalHours.toFixed(2)),
        leaveHours: Number(totalLeaveHours.toFixed(2)),
      },
    };
  }

  async getAllUsersSalarySummaryCSV(params: {
    orgId: number;
    startDate?: string;
    endDate?: string;
  }) {
    const { orgId, startDate, endDate } = params;

    let finalStartDate: string;
    let finalEndDate: string;

    // If dates not provided, use current salary cycle
    if (!startDate || !endDate) {
      const now = new Date();
      const currentCycle = SalaryCycleUtil.getCurrentSalaryCycle(now);
      
      // Calculate display dates: 26th to 25th
      const displayStart = new Date(currentCycle.start);
      displayStart.setUTCDate(26);
      
      const displayEnd = new Date(currentCycle.end);
      displayEnd.setUTCDate(25);
      
      finalStartDate = displayStart.toISOString().split('T')[0];
      finalEndDate = displayEnd.toISOString().split('T')[0];
    } else {
      finalStartDate = startDate;
      finalEndDate = endDate;
    }

    // Parse and validate dates
    const start = new Date(finalStartDate);
    const end = new Date(finalEndDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('startDate and endDate must be valid ISO dates (YYYY-MM-DD)');
    }

    if (end < start) {
      throw new BadRequestException('endDate must be greater than or equal to startDate');
    }

    const db = this.database.connection;

    // Get all active users in the organization
    const users = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        employmentType: usersTable.employmentType,
        employmentStatus: usersTable.employmentStatus,
        employeeDepartmentId: usersTable.employeeDepartmentId,
      })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.orgId, orgId),
          or(
            isNull(usersTable.employmentStatus),
            not(eq(usersTable.employmentStatus, 'inactive'))
          )
        )
      )
      .orderBy(asc(usersTable.name));

    // Get salary summary for each user with custom date range
    const summaries = await Promise.all(
      users.map(async (user) => {
        try {
          return await this.getSalarySummary({
            userId: user.id,
            orgId,
            startDate: finalStartDate,
            endDate: finalEndDate,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error(`Error getting salary summary for user ${user.id}: ${errorMessage}`);
          return null;
        }
      })
    );

    // Filter out null results (errors)
    const validSummaries = summaries.filter((s) => s !== null);

    // Convert to CSV
    const csv = this.convertToCSV(validSummaries);

    return {
      csv,
      startDate: finalStartDate,
      endDate: finalEndDate,
    };
  }

  async getAllUsersPayableDaysCSVByCycle(params: {
    orgId: number;
    cycle: string;
  }) {
    const { orgId, cycle } = params;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(cycle)) {
      throw new BadRequestException('cycle must be in YYYY-MM-DD format');
    }

    const parsedCycle = new Date(`${cycle}T00:00:00.000Z`);
    if (Number.isNaN(parsedCycle.getTime())) {
      throw new BadRequestException('cycle must be a valid date in YYYY-MM-DD format');
    }

    const cycleDate = this.normalizeDateUTC(parsedCycle);
    const cycleDay = cycleDate.getUTCDate();

    const cycleEnd = new Date(cycleDate);
    if (cycleDay >= 26) {
      // If date is on/after 26th, cycle ends on 25th of next month.
      cycleEnd.setUTCMonth(cycleEnd.getUTCMonth() + 1, 25);
    } else {
      // If date is before 26th, cycle ends on 25th of current month.
      cycleEnd.setUTCDate(25);
    }

    const cycleStart = new Date(cycleEnd);
    cycleStart.setUTCMonth(cycleStart.getUTCMonth() - 1, 26);

    const db = this.database.connection;

    const users = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        employmentType: usersTable.employmentType,
        joiningDate: usersTable.dateOfJoining,
        exitDate: usersTable.dateOfExit,
        status: usersTable.employmentStatus,
      })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.orgId, orgId),
          or(
            isNull(usersTable.employmentStatus),
            not(eq(usersTable.employmentStatus, 'inactive')),
          ),
        ),
      )
      .orderBy(asc(usersTable.id));

    const userIds = users.map((user) => user.id);
    const payableDaysRows =
      userIds.length === 0
        ? []
        : await db
            .select({
              userId: payableDaysTable.userId,
              expectedAttendance: payableDaysTable.expectedAttendance,
              totalWorkingDays: payableDaysTable.totalWorkingDays,
              weekOff: payableDaysTable.weekOff,
              totalPayableDays: payableDaysTable.totalPayableDays,
            })
            .from(payableDaysTable)
            .where(
              and(
                eq(payableDaysTable.cycle, cycle),
                inArray(payableDaysTable.userId, userIds),
              ),
            );

    const cycleEndExclusive = new Date(cycleEnd);
    cycleEndExclusive.setUTCDate(cycleEndExclusive.getUTCDate() + 1);

    const cycleTimesheets =
      userIds.length === 0
        ? []
        : await db
            .select({
              userId: timesheetsTable.userId,
              totalHours: timesheetsTable.totalHours,
            })
            .from(timesheetsTable)
            .where(
              and(
                eq(timesheetsTable.orgId, orgId),
                inArray(timesheetsTable.userId, userIds),
                gte(timesheetsTable.workDate, cycleStart),
                lt(timesheetsTable.workDate, cycleEndExclusive),
              ),
            );

    const totalTimesheetHoursByUserId = new Map<number, number>();
    for (const row of cycleTimesheets) {
      const userId = Number(row.userId);
      const hours = Number(row.totalHours ?? 0);
      if (!Number.isFinite(hours)) {
        continue;
      }

      totalTimesheetHoursByUserId.set(
        userId,
        Number(((totalTimesheetHoursByUserId.get(userId) ?? 0) + hours).toFixed(2)),
      );
    }

    const payableDaysByUserId = new Map(
      payableDaysRows.map((row) => [Number(row.userId), row]),
    );

    const parseNumericValue = (value: unknown): number => {
      const parsed = Number(value ?? 0);
      if (!Number.isFinite(parsed)) {
        return 0;
      }
      return parsed;
    };

    const workingDayInfo = await this.getWorkingDayInfo(orgId, cycleStart, cycleEnd);
    const leaveBreakdownByUserId = await this.getApprovedLeaveBreakdownByUserForCycle({
      userIds,
      monthStart: cycleStart,
      monthEnd: cycleEnd,
      workingDayInfo,
    });

    const payableRows = users.map((user) => {
        const leaveBreakdown = leaveBreakdownByUserId.get(user.id) ?? {
          earnLeave: 0,
          specialLeave: 0,
          compOffLeaves: 0,
          lwp: 0,
        };
        const payableRow = payableDaysByUserId.get(user.id);

        return {
          userId: user.id,
          email: user.email,
          employmentType: user.employmentType,
          joiningDate: user.joiningDate,
          exitDate: user.exitDate,
          status: user.status,
          expectedAttendance: parseNumericValue(payableRow?.expectedAttendance),
          cycle,
          totalHours: Number(
            (totalTimesheetHoursByUserId.get(user.id) ?? 0).toFixed(1),
          ),
          totalWorkingDays: Number(
            parseNumericValue(payableRow?.totalWorkingDays).toFixed(1),
          ),
          earnLeave: Number(leaveBreakdown.earnLeave.toFixed(1)),
          specialLeave: Number(leaveBreakdown.specialLeave.toFixed(1)),
          compOffLeaves: Number(leaveBreakdown.compOffLeaves.toFixed(1)),
          weekOff: Number(parseNumericValue(payableRow?.weekOff).toFixed(1)),
          totalPayableDays: Number(
            parseNumericValue(payableRow?.totalPayableDays).toFixed(1),
          ),
          lwp: Number(leaveBreakdown.lwp.toFixed(1)),
        };
      });

    const csv = this.convertPayableDaysToCSV(payableRows);

    return {
      csv,
      cycle,
      count: payableRows.length,
    };
  }

  private convertPayableDaysToCSV(
    data: Array<{
      userId: number;
      email: string;
      employmentType: string | null;
      joiningDate: string | Date | null;
      exitDate: string | Date | null;
      status: string | null;
      expectedAttendance: number | null;
      cycle: string;
      totalHours: number;
      totalWorkingDays: number;
      earnLeave: number;
      specialLeave: number;
      compOffLeaves: number;
      weekOff: number;
      totalPayableDays: number;
      lwp: number;
    }>,
  ): string {
    const headers = [
      'Email',
      'Employment Type',
      'Joining Date',
      'Exit Date',
      'Status',
      'Expected Attendance',
      'Cycle',
      'Total Hours',
      'Total Working Days',
      'Earn Leave',
      'Special Leave',
      'Comp Off Leaves',
      'Week Off',
      'Total Payable Days',
      'LWP',
    ];

    if (data.length === 0) {
      return headers.join(',');
    }

    const rows = data.map((row) => [
      this.escapeCSVValue(row.email),
      this.escapeCSVValue(row.employmentType),
      this.escapeCSVValue(this.formatCsvDateValue(row.joiningDate)),
      this.escapeCSVValue(this.formatCsvDateValue(row.exitDate)),
      this.escapeCSVValue(row.status),
      row.expectedAttendance ?? '',
      this.escapeCSVValue(row.cycle),
      row.totalHours,
      row.totalWorkingDays,
      row.earnLeave,
      row.specialLeave,
      row.compOffLeaves,
      row.weekOff,
      row.totalPayableDays,
      row.lwp,
    ]);

    return [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
  }

  private formatCsvDateValue(value: string | Date | null | undefined): string {
    if (!value) {
      return '';
    }

    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        return '';
      }
      return value.toISOString().split('T')[0];
    }

    return value.includes('T') ? value.split('T')[0] : value;
  }

  private convertToCSV(data: Awaited<ReturnType<typeof this.getSalarySummary>>[]): string {
    if (data.length === 0) {
      return 'No data available';
    }

    // Define CSV headers
    const headers = [
      'Email',
      'Name',
      'Employment Type',
      'Status',
      'Total Hours',
      'Total Working Days',
      'Paid Leaves',
      'Comp Off Leaves Taken',
      'Week Off Days',
      'Total Payable Days',
      'LWP',
    ];

    // Create CSV rows
    const rows = data.map((row) => [
      this.escapeCSVValue(row.email),
      this.escapeCSVValue(row.name),
      this.escapeCSVValue(row.employmentType),
      this.escapeCSVValue(row.status),
      row.totalHours,
      row.totalWorkingDays,
      row.paidLeaves,
      row.totalCompOffLeaveTaken,
      row.weekOffDays,
      row.totalPayableDays,
      row.LWP,
    ]);

    // Combine headers and rows
    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.join(',')),
    ].join('\n');

    return csvContent;
  }

  private formatDateWithDay(isoDate: string): string {
    const date = new Date(isoDate);
    const day = date.getUTCDate();
    const month = date.getUTCMonth() + 1;
    const year = date.getUTCFullYear();
    return `${day}/${month}/${year}`;
  }

  private isEarnLeaveType(
    leaveTypeCode: string | null | undefined,
    leaveTypeName: string | null | undefined,
  ): boolean {
    const code = (leaveTypeCode ?? '').toLowerCase();
    const name = (leaveTypeName ?? '').toLowerCase();

    const earnLeaveCodes = new Set(['casual', 'casual_leave', 'wellness', 'wellness_leave']);
    return (
      earnLeaveCodes.has(code) ||
      name.includes('casual') ||
      name.includes('wellness')
    );
  }

  private async getApprovedLeaveBreakdownByUserForCycle(params: {
    userIds: number[];
    monthStart: Date;
    monthEnd: Date;
    workingDayInfo: Map<
      string,
      { isWorkingDay: boolean; isHoliday: boolean; isWeekend: boolean; holidayName: string | null }
    >;
  }): Promise<
    Map<number, { earnLeave: number; specialLeave: number; compOffLeaves: number; lwp: number }>
  > {
    const { userIds, monthStart, monthEnd, workingDayInfo } = params;
    const db = this.database.connection;

    if (userIds.length === 0) {
      return new Map();
    }

    const approvedLeaves = await db
      .select({
        userId: leaveRequestsTable.userId,
        startDate: leaveRequestsTable.startDate,
        endDate: leaveRequestsTable.endDate,
        hours: leaveRequestsTable.hours,
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
          inArray(leaveRequestsTable.userId, userIds),
          eq(leaveRequestsTable.state, 'approved'),
          lte(leaveRequestsTable.startDate, monthEnd),
          gte(leaveRequestsTable.endDate, monthStart),
        ),
      );

    const leaveByUser = new Map<
      number,
      { earnLeave: number; specialLeave: number; compOffLeaves: number; lwp: number }
    >();

    for (const request of approvedLeaves) {
      const userId = Number(request.userId);
      const bucket = leaveByUser.get(userId) ?? {
        earnLeave: 0,
        specialLeave: 0,
        compOffLeaves: 0,
        lwp: 0,
      };

      const requestStart = this.normalizeDateUTC(new Date(request.startDate));
      const requestEnd = this.normalizeDateUTC(new Date(request.endDate));
      const requestHours = request.hours ? Number(request.hours) : 0;

      const windowStart = requestStart > monthStart ? requestStart : monthStart;
      const windowEnd = requestEnd < monthEnd ? requestEnd : monthEnd;

      if (windowEnd < windowStart) {
        continue;
      }

      const dayKeys: string[] = [];
      const cursor = new Date(windowStart);
      while (cursor <= windowEnd) {
        const key = this.formatDateKey(cursor);
        if (workingDayInfo.get(key)?.isWorkingDay) {
          dayKeys.push(key);
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      if (dayKeys.length === 0) {
        continue;
      }

      let leaveDaysCount = 0;
      if (requestHours > 0) {
        leaveDaysCount = requestHours / HOURS_PER_WORKING_DAY;
      } else if (request.durationType === 'half_day') {
        leaveDaysCount = dayKeys.length * 0.5;
      } else {
        leaveDaysCount = dayKeys.length;
      }

      const leaveTypeCode = request.leaveTypeCode ?? '';
      const leaveTypeName = request.leaveTypeName ?? '';
      const normalizedName = leaveTypeName.toLowerCase();
      const isLWP = leaveTypeCode === 'lwp' || normalizedName.includes('without pay');
      const isCompOff = leaveTypeCode === 'comp_off' || normalizedName.includes('comp off');

      if (isLWP) {
        bucket.lwp += leaveDaysCount;
      } else if (isCompOff) {
        bucket.compOffLeaves += leaveDaysCount;
      } else if (this.isEarnLeaveType(leaveTypeCode, leaveTypeName)) {
        bucket.earnLeave += leaveDaysCount;
      } else {
        bucket.specialLeave += leaveDaysCount;
      }

      leaveByUser.set(userId, bucket);
    }

    return leaveByUser;
  }

  private escapeCSVValue(value: any): string {
    if (value === null || value === undefined) {
      return '';
    }
    
    const stringValue = String(value);
    
    // If the value contains comma, newline, or double quote, wrap it in quotes
    if (stringValue.includes(',') || stringValue.includes('\n') || stringValue.includes('"')) {
      // Escape double quotes by doubling them
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    
    return stringValue;
  }

  private async countBackfilledDaysForMonth(
    orgId: number,
    userId: number,
    referenceDate: Date,
    now: Date
  ) {
    const db = this.database.connection;

    const year = referenceDate.getUTCFullYear();
    const month = referenceDate.getUTCMonth() + 1;

    // Count actual backfill entries from the backfill_dates table
    const [{ value: backfillCount }] = await db
      .select({ value: count(backfillDatesTable.id) })
      .from(backfillDatesTable)
      .where(
        and(
          eq(backfillDatesTable.orgId, orgId),
          eq(backfillDatesTable.userId, userId),
          eq(backfillDatesTable.year, year),
          eq(backfillDatesTable.month, month)
        )
      );

    return Number(backfillCount ?? 0);
  }

  private async enqueueSlackNotification(
    orgId: number,
    channelId: string,
    template: string,
    payload: Record<string, unknown>
  ) {
    await this.database.connection.insert(notificationsTable).values({
      orgId,
      channel: 'slack',
      toRef: { channelId },
      template,
      payload,
      state: 'pending',
    });
  }

  private async enqueueDiscordNotification(
    orgId: number,
    webhookUrl: string,
    template: string,
    payload: Record<string, unknown>
  ) {
    await this.database.connection.insert(notificationsTable).values({
      orgId,
      channel: 'discord',
      toRef: { webhookUrl },
      template,
      payload,
      state: 'pending',
    });
  }

  /**
   * Get backfill allowance for the current salary cycle
   * Lifelines reset on 26th at 7:00 AM of each month
   */
  private async getBackfillAllowanceForCycle(
    orgId: number,
    userId: number,
    cycle: ReturnType<typeof SalaryCycleUtil.getCurrentSalaryCycle>,
    now: Date
  ) {
    const year = cycle.year;
    const month = cycle.month;

    let counter = await this.getOrCreateBackfillCounterForCycle(
      orgId,
      userId,
      year,
      month,
      cycle,
      now
    );

    const remaining = Math.max(counter.limit - counter.used, 0);
    return {
      limit: counter.limit,
      used: counter.used,
      remaining,
    };
  }

  private async getBackfillAllowance(
    orgId: number,
    userId: number,
    referenceDate: Date,
    now: Date
  ) {
    const year = referenceDate.getUTCFullYear();
    const month = referenceDate.getUTCMonth() + 1;

    let counter = await this.getOrCreateBackfillCounter(
      orgId,
      userId,
      year,
      month,
      now
    );

    const remaining = Math.max(counter.limit - counter.used, 0);
    return {
      limit: counter.limit,
      used: counter.used,
      remaining,
    };
  }

  private async getOrCreateBackfillCounter(
    orgId: number,
    userId: number,
    year: number,
    month: number,
    now: Date
  ) {
    const db = this.database.connection;

    const [existing] = await db
      .select({
        id: backfillCountersTable.id,
        used: backfillCountersTable.used,
        limit: backfillCountersTable.limit,
      })
      .from(backfillCountersTable)
      .where(
        and(
          eq(backfillCountersTable.orgId, orgId),
          eq(backfillCountersTable.userId, userId),
          eq(backfillCountersTable.year, year),
          eq(backfillCountersTable.month, month)
        )
      )
      .limit(1);

    if (existing) {
      return {
        id: existing.id,
        used: Number(existing.used ?? 0),
        limit: Number(existing.limit ?? DEFAULT_BACKFILL_PER_MONTH),
      };
    }

    const computedUsed = await this.countBackfilledDaysForMonth(
      orgId,
      userId,
      new Date(Date.UTC(year, month - 1, 1)),
      now
    );

    const [created] = await db
      .insert(backfillCountersTable)
      .values({
        orgId,
        userId,
        year,
        month,
        used: computedUsed,
        limit: DEFAULT_BACKFILL_PER_MONTH,
        lastUsedAt: null,
      })
      .returning({
        id: backfillCountersTable.id,
        used: backfillCountersTable.used,
        limit: backfillCountersTable.limit,
      });

    return {
      id: created.id,
      used: Number(created.used ?? computedUsed),
      limit: Number(created.limit ?? DEFAULT_BACKFILL_PER_MONTH),
    };
  }

  /**
   * Get or create backfill counter for a salary cycle
   * This replaces the calendar month-based counter
   */
  private async getOrCreateBackfillCounterForCycle(
    orgId: number,
    userId: number,
    year: number,
    month: number,
    cycle: ReturnType<typeof SalaryCycleUtil.getCurrentSalaryCycle>,
    now: Date
  ) {
    const db = this.database.connection;

    // Always recalculate from backfill_dates table (source of truth)
    const computedUsed = await this.countBackfilledDaysForCycle(
      orgId,
      userId,
      cycle,
      now
    );

    const [existing] = await db
      .select({
        id: backfillCountersTable.id,
        used: backfillCountersTable.used,
        limit: backfillCountersTable.limit,
      })
      .from(backfillCountersTable)
      .where(
        and(
          eq(backfillCountersTable.orgId, orgId),
          eq(backfillCountersTable.userId, userId),
          eq(backfillCountersTable.year, year),
          eq(backfillCountersTable.month, month)
        )
      )
      .limit(1);

    if (existing) {
      // Return the computed used count from backfill_dates, not the stored value
      return {
        id: existing.id,
        used: computedUsed,
        limit: Number(existing.limit ?? DEFAULT_BACKFILL_PER_MONTH),
      };
    }

    const [created] = await db
      .insert(backfillCountersTable)
      .values({
        orgId,
        userId,
        year,
        month,
        used: computedUsed,
        limit: DEFAULT_BACKFILL_PER_MONTH,
        lastUsedAt: null,
      })
      .returning({
        id: backfillCountersTable.id,
        used: backfillCountersTable.used,
        limit: backfillCountersTable.limit,
      });

    return {
      id: created.id,
      used: computedUsed,
      limit: Number(created.limit ?? DEFAULT_BACKFILL_PER_MONTH),
    };
  }

  /**
   * Count backfilled days within a salary cycle
   */
  private async countBackfilledDaysForCycle(
    orgId: number,
    userId: number,
    cycle: ReturnType<typeof SalaryCycleUtil.getCurrentSalaryCycle>,
    now: Date
  ) {
    const db = this.database.connection;

    const year = cycle.year;
    const month = cycle.month;

    // Count actual backfill entries from the backfill_dates table for this cycle
    const [{ value: backfillCount }] = await db
      .select({ value: count(backfillDatesTable.id) })
      .from(backfillDatesTable)
      .where(
        and(
          eq(backfillDatesTable.orgId, orgId),
          eq(backfillDatesTable.userId, userId),
          eq(backfillDatesTable.year, year),
          eq(backfillDatesTable.month, month)
        )
      );

    return Number(backfillCount ?? 0);
  }

  private async incrementBackfillUsage(
    tx: DatabaseService["connection"],
    orgId: number,
    userId: number,
    workDate: Date,
    now: Date
  ) {
    const year = workDate.getUTCFullYear();
    const month = workDate.getUTCMonth() + 1;
    const workDateKey = this.formatDateKey(workDate);

    const insertedDate = await tx
      .insert(backfillDatesTable)
      .values({
        orgId,
        userId,
        year,
        month,
        workDate: workDateKey,
      })
      .onConflictDoNothing()
      .returning({ id: backfillDatesTable.id });

    if (insertedDate.length === 0) {
      // Already counted
      return;
    }

    const updated = await tx
      .update(backfillCountersTable)
      .set({
        used: sql`${backfillCountersTable.used} + 1`,
        lastUsedAt: now,
      })
      .where(
        and(
          eq(backfillCountersTable.orgId, orgId),
          eq(backfillCountersTable.userId, userId),
          eq(backfillCountersTable.year, year),
          eq(backfillCountersTable.month, month)
        )
      )
      .returning({ id: backfillCountersTable.id, used: backfillCountersTable.used });

    if (updated.length === 0) {
      await tx
        .insert(backfillCountersTable)
        .values({
          orgId,
          userId,
          year,
          month,
          used: 1,
          limit: DEFAULT_BACKFILL_PER_MONTH,
          lastUsedAt: now,
        })
        .onConflictDoNothing();
    }
  }

  /**
   * Increment backfill usage for salary cycle
   */
  private async incrementBackfillUsageForCycle(
    tx: DatabaseService["connection"],
    orgId: number,
    userId: number,
    cycle: ReturnType<typeof SalaryCycleUtil.getCurrentSalaryCycle>,
    workDate: Date,
    now: Date
  ) {
    const year = cycle.year;
    const month = cycle.month;
    const workDateKey = this.formatDateKey(workDate);

    const insertedDate = await tx
      .insert(backfillDatesTable)
      .values({
        orgId,
        userId,
        year,
        month,
        workDate: workDateKey,
      })
      .onConflictDoNothing()
      .returning({ id: backfillDatesTable.id });

    if (insertedDate.length === 0) {
      // Already counted
      return;
    }

    const updated = await tx
      .update(backfillCountersTable)
      .set({
        used: sql`${backfillCountersTable.used} + 1`,
        lastUsedAt: now,
      })
      .where(
        and(
          eq(backfillCountersTable.orgId, orgId),
          eq(backfillCountersTable.userId, userId),
          eq(backfillCountersTable.year, year),
          eq(backfillCountersTable.month, month)
        )
      )
      .returning({ id: backfillCountersTable.id, used: backfillCountersTable.used });

    if (updated.length === 0) {
      await tx
        .insert(backfillCountersTable)
        .values({
          orgId,
          userId,
          year,
          month,
          used: 1,
          limit: DEFAULT_BACKFILL_PER_MONTH,
          lastUsedAt: now,
        })
        .onConflictDoNothing();
    }
  }

  private normalizeDateUTC(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    );
  }

  private formatDateKey(date: Date): string {
    return this.normalizeDateUTC(date).toISOString().slice(0, 10);
  }

  private formatDateDDMMYYYY(date: Date): string {
    const d = this.normalizeDateUTC(date);
    const dd = d.getUTCDate().toString().padStart(2, "0");
    const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    return `${dd}-${mm}-${yyyy}`;
  }

  private async getWorkingDayInfo(
    orgId: number,
    start: Date,
    end: Date
  ): Promise<
    Map<
      string,
      { isWorkingDay: boolean; isHoliday: boolean; isWeekend: boolean; holidayName: string | null }
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
      { isWorkingDay: boolean; isHoliday: boolean; isWeekend: boolean; holidayName: string | null }
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
      const holidayName = override && !override.isWorkingDay ? override.name : null;

      info.set(key, {
        isWorkingDay,
        isHoliday,
        isWeekend: isSunday || isSaturday,
        holidayName,
      });

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return info;
  }

  private isSecondOrFourthSaturday(date: Date): boolean {
    const occurrence = Math.ceil(date.getUTCDate() / 7);
    return occurrence === 2 || occurrence === 4;
  }

  async updateTimesheetEntry(
    entryId: number,
    targetUserId: number,
    updateData: {
      projectId?: number;
      date?: string;
      hours?: number;
      activities?: string;
    },
    orgId: number,
    actor?: AuthenticatedUser,
  ) {
    const db = this.database.connection;
    const now = new Date();

    // Check if the entry exists and belongs to the specified user
    const [existingEntry] = await db
      .select({
        id: timesheetEntriesTable.id,
        timesheetId: timesheetEntriesTable.timesheetId,
        workDate: timesheetsTable.workDate,
        projectId: timesheetEntriesTable.projectId,
        hoursDecimal: timesheetEntriesTable.hoursDecimal,
        taskDescription: timesheetEntriesTable.taskDescription,
      })
      .from(timesheetEntriesTable)
      .innerJoin(
        timesheetsTable,
        eq(timesheetEntriesTable.timesheetId, timesheetsTable.id),
      )
      .where(
        and(
          eq(timesheetEntriesTable.id, entryId),
          eq(timesheetEntriesTable.orgId, orgId),
          eq(timesheetsTable.userId, targetUserId),
        ),
      );

    if (!existingEntry) {
      throw new NotFoundException(
        `Timesheet entry with ID ${entryId} for user ${targetUserId} not found`,
      );
    }

    const oldWorkDate = existingEntry.workDate;

    const updatePayload: any = {
      updatedAt: now,
    };

    if (updateData.projectId !== undefined) {
      updatePayload.projectId = updateData.projectId;
    }

    if (updateData.hours !== undefined) {
      if (updateData.hours <= 0 || updateData.hours > MAX_HOURS_PER_DAY) {
        throw new BadRequestException(
          `Hours must be between 0 and ${MAX_HOURS_PER_DAY}`,
        );
      }
      updatePayload.hoursDecimal = updateData.hours.toString();
    }

    if (updateData.activities !== undefined) {
      updatePayload.taskDescription = updateData.activities;
    }

    // Check if project is "Ad-hoc tasks" and enforce 2-hour limit
    const projectIdToCheck = updateData.projectId ?? existingEntry.projectId;
    if (projectIdToCheck) {
      const [project] = await db
        .select({
          name: projectsTable.name,
        })
        .from(projectsTable)
        .where(eq(projectsTable.id, projectIdToCheck))
        .limit(1);

      if (project && project.name === 'Ad-hoc tasks') {
        const hoursToSet = updateData.hours ?? Number(existingEntry.hoursDecimal ?? 0);
        if (hoursToSet > 2) {
          throw new BadRequestException(
            `Ad-hoc tasks project cannot have more than 2 hours`,
          );
        }
      }
    }

    // If date is being updated, we need to check if the target timesheet exists or create it
    let targetTimesheetId = existingEntry.timesheetId;
    let targetWorkDate = normalizeDate(existingEntry.workDate);
    if (updateData.date) {
      const workDate = normalizeDate(new Date(updateData.date));

      const today = normalizeDate(now);
      if (workDate > today) {
        throw new BadRequestException('Cannot move timesheet entry to a future date');
      }

      // Find or create the target timesheet for the user
      const [targetTimesheet] = await db
        .select()
        .from(timesheetsTable)
        .where(
          and(
            eq(timesheetsTable.userId, targetUserId),
            eq(timesheetsTable.workDate, workDate),
            eq(timesheetsTable.orgId, orgId),
          ),
        );

      if (!targetTimesheet) {
        // Create new timesheet for the target date
        const [newTimesheet] = await db
          .insert(timesheetsTable)
          .values({
            orgId,
            userId: targetUserId,
            workDate,
            state: 'draft',
            totalHours: '0',
            submittedAt: now,
          })
          .returning({ id: timesheetsTable.id });
        targetTimesheetId = newTimesheet.id;
      } else {
        targetTimesheetId = targetTimesheet.id;
      }

      updatePayload.timesheetId = targetTimesheetId;
      targetWorkDate = workDate;
    }

    const updatedEntryHours =
      updateData.hours !== undefined
        ? Number(updateData.hours)
        : Number(existingEntry.hoursDecimal ?? 0);

    const [{ totalHoursExcludingCurrent }] = await db
      .select({
        totalHoursExcludingCurrent:
          sql<number>`COALESCE(SUM(${timesheetEntriesTable.hoursDecimal}), 0)`,
      })
      .from(timesheetEntriesTable)
      .where(
        and(
          eq(timesheetEntriesTable.timesheetId, targetTimesheetId),
          not(eq(timesheetEntriesTable.id, entryId)),
        ),
      );

    const totalHoursForDayAfterUpdate =
      Number(totalHoursExcludingCurrent ?? 0) + updatedEntryHours;

    if (totalHoursForDayAfterUpdate > MAX_HOURS_PER_DAY) {
      throw new BadRequestException(
        `Timesheet hours cannot exceed ${MAX_HOURS_PER_DAY} hours per day`,
      );
    }

    await this.enforceLeaveBasedDailyHoursLimit(
      targetUserId,
      targetWorkDate,
      totalHoursForDayAfterUpdate,
    );

    // Update the entry
    const [updatedEntry] = await db
      .update(timesheetEntriesTable)
      .set(updatePayload)
      .where(eq(timesheetEntriesTable.id, entryId))
      .returning();

    const actorRole = this.getPrivilegedActorRole(actor?.roles ?? []);
    if (actorRole) {
      await this.auditService.createLog({
        orgId,
        actorUserId: actor?.id,
        actorRole,
        action: 'timesheet_edited',
        subjectType: 'timesheet_edited',
        targetUserId,
        prev: {
          projectId: existingEntry.projectId,
          hours: Number(existingEntry.hoursDecimal ?? 0),
          activities: existingEntry.taskDescription ?? null,
        },
        next: {
          projectId: updatedEntry.projectId,
          hours: Number(updatedEntry.hoursDecimal ?? 0),
          activities: updatedEntry.taskDescription ?? null,
        },
      });
    }

    // Recalculate total hours for affected timesheets (only approved entries)
    const timesheetIds = new Set<number>([existingEntry.timesheetId]);
    if (updatePayload.timesheetId) {
      timesheetIds.add(updatePayload.timesheetId);
    }

    for (const timesheetId of timesheetIds) {
      const [{ totalHours }] = await db
        .select({
          totalHours: sql<number>`COALESCE(SUM(${timesheetEntriesTable.hoursDecimal}), 0)`,
        })
        .from(timesheetEntriesTable)
        .where(
          and(
            eq(timesheetEntriesTable.timesheetId, timesheetId),
            eq(timesheetEntriesTable.status, 'approved'),
          ),
        );

      await db
        .update(timesheetsTable)
        .set({
          totalHours: String(totalHours ?? 0),
          updatedAt: now,
        })
        .where(eq(timesheetsTable.id, timesheetId));
    }

    const dateChanged =
      updateData.date &&
      normalizeDate(new Date(updateData.date as string)).getTime() !==
        new Date(oldWorkDate).getTime();

    if (dateChanged) {
      const newWorkDate = normalizeDate(new Date(updateData.date as string));

      // Re-evaluate comp-off for the old date
      const [oldTimesheet] = await db
        .select({ totalHours: timesheetsTable.totalHours })
        .from(timesheetsTable)
        .where(eq(timesheetsTable.id, existingEntry.timesheetId));

      if (oldTimesheet) {
        await this.leavesService.tryProcessCompOffForTimesheet(
          orgId,
          targetUserId,
          new Date(oldWorkDate),
          existingEntry.timesheetId,
          Number(oldTimesheet.totalHours ?? 0),
        );
      }

      // Trigger comp-off for the new date
      const [newTimesheet] = await db
        .select({ totalHours: timesheetsTable.totalHours })
        .from(timesheetsTable)
        .where(eq(timesheetsTable.id, targetTimesheetId));

      if (newTimesheet) {
        await this.leavesService.tryProcessCompOffForTimesheet(
          orgId,
          targetUserId,
          newWorkDate,
          targetTimesheetId,
          Number(newTimesheet.totalHours ?? 0),
        );
      }
    } else {
      // If only hours changed (but not date), still trigger comp-off validation
      const oldHours = Number(existingEntry.hoursDecimal ?? 0);
      const newHours =
        updateData.hours !== undefined
          ? Number(updateData.hours)
          : oldHours;

      if (newHours !== oldHours) {
        const [timesheet] = await db
          .select({ totalHours: timesheetsTable.totalHours })
          .from(timesheetsTable)
          .where(eq(timesheetsTable.id, targetTimesheetId));

        if (timesheet) {
          await this.leavesService.tryProcessCompOffForTimesheet(
            orgId,
            targetUserId,
            new Date(oldWorkDate),
            targetTimesheetId,
            Number(timesheet.totalHours ?? 0),
          );
        }
      }
    }

    const cycleKeysToRecalculate = new Set<string>();

    const previousCycle = this.getCycleRangeForWorkDate(
      new Date(existingEntry.workDate),
    );
    cycleKeysToRecalculate.add(previousCycle.cycleKey);

    if (updateData.date) {
      const newCycle = this.getCycleRangeForWorkDate(
        normalizeDate(new Date(updateData.date)),
      );
      cycleKeysToRecalculate.add(newCycle.cycleKey);
    }

    for (const cycleKey of cycleKeysToRecalculate) {
      const cycleDate = new Date(`${cycleKey}T00:00:00.000Z`);
      const cycleRange = this.getCycleRangeForWorkDate(cycleDate);
      await this.recalculateAndPersistPayableDaysForCycle(
        db,
        orgId,
        targetUserId,
        cycleRange.cycleStart,
        cycleRange.cycleEnd,
        cycleRange.cycleKey,
        now,
      );
    }

    return updatedEntry;
  }

  async deleteTimesheetEntry(
    entryId: number,
    targetUserId: number,
    orgId: number,
    actor?: AuthenticatedUser,
  ) {
    try {
      const db = this.database.connection;
      const now = new Date();

      // Check if the entry exists and belongs to the specified user
      const [existingEntry] = await db
        .select({
          id: timesheetEntriesTable.id,
          timesheetId: timesheetEntriesTable.timesheetId,
          projectId: timesheetEntriesTable.projectId,
          hoursDecimal: timesheetEntriesTable.hoursDecimal,
          taskDescription: timesheetEntriesTable.taskDescription,
          status: timesheetEntriesTable.status,
        })
        .from(timesheetEntriesTable)
        .innerJoin(
          timesheetsTable,
          eq(timesheetEntriesTable.timesheetId, timesheetsTable.id),
        )
        .where(
          and(
            eq(timesheetEntriesTable.id, entryId),
            eq(timesheetEntriesTable.orgId, orgId),
            eq(timesheetsTable.userId, targetUserId),
          ),
        );

      if (!existingEntry) {
        return {
          success: false,
          message: `Timesheet entry with ID ${entryId} for user ${targetUserId} not found.`,
          entryId,
          targetUserId,
        };
      }

      const timesheetId = existingEntry.timesheetId;
      const hoursToDelete = Number(existingEntry.hoursDecimal ?? 0);

      // Permanently delete the timesheet entry
      try {
        const deleteResult = await db
          .delete(timesheetEntriesTable)
          .where(eq(timesheetEntriesTable.id, entryId));

        if (!deleteResult) {
          return {
            success: false,
            message: `Failed to delete timesheet entry with ID ${entryId}. Entry may have already been deleted or no longer exists.`,
            entryId,
            targetUserId,
          };
        }
      } catch (deleteError) {
        const errorMsg = deleteError instanceof Error ? deleteError.message : 'Unknown error';
        this.logger.error(`Database error while deleting entry ${entryId}:`, deleteError);
        return {
          success: false,
          message: `Failed to delete timesheet entry from database. Error: ${errorMsg}`,
          entryId,
          targetUserId,
          error: errorMsg,
        };
      }

      // Recalculate total hours for the affected timesheet (sum all approved entries)
      let totalHours: number;
      try {
        const [result] = await db
          .select({
            totalHours: sql<number>`COALESCE(SUM(${timesheetEntriesTable.hoursDecimal}), 0)`,
          })
          .from(timesheetEntriesTable)
          .where(
            and(
              eq(timesheetEntriesTable.timesheetId, timesheetId),
              eq(timesheetEntriesTable.status, 'approved'),
            ),
          );

        totalHours = Number(result?.totalHours ?? 0);
      } catch (recalcError) {
        const errorMsg = recalcError instanceof Error ? recalcError.message : 'Unknown error';
        this.logger.error(`Failed to recalculate hours for timesheet ${timesheetId}:`, recalcError);
        return {
          success: false,
          message: `Timesheet entry was deleted, but failed to recalculate total hours. Error: ${errorMsg}`,
          entryId,
          targetUserId,
          error: errorMsg,
        };
      }

      const totalHoursNum = Number(totalHours ?? 0);

      // Get timesheet info before updating
      const [timesheet] = await db
        .select({
          workDate: timesheetsTable.workDate,
        })
        .from(timesheetsTable)
        .where(eq(timesheetsTable.id, timesheetId))
        .limit(1);

      if (!timesheet) {
        return {
          success: false,
          message: `Timesheet with ID ${timesheetId} not found after entry deletion.`,
          entryId,
          targetUserId,
        };
      }

      // If no approved entries remain, delete the timesheet; otherwise update total hours
      try {
        if (totalHoursNum === 0) {
          // Permanently delete the timesheet if it has no entries
          const deleteResult = await db
            .delete(timesheetsTable)
            .where(eq(timesheetsTable.id, timesheetId));

          if (!deleteResult) {
            return {
              success: false,
              message: `Failed to delete empty timesheet with ID ${timesheetId}. Timesheet entry was deleted but timesheet deletion failed.`,
              entryId,
              targetUserId,
              timesheetId,
            };
          }
        } else {
          // Update timesheet with recalculated total hours
          const updateResult = await db
            .update(timesheetsTable)
            .set({
              totalHours: String(totalHoursNum),
              updatedAt: now,
            })
            .where(eq(timesheetsTable.id, timesheetId));

          if (!updateResult) {
            return {
              success: false,
              message: `Failed to update timesheet total hours after entry deletion. Entry was deleted but timesheet update failed.`,
              entryId,
              targetUserId,
              timesheetId,
            };
          }
        }
      } catch (timesheetError) {
        const errorMsg = timesheetError instanceof Error ? timesheetError.message : 'Unknown error';
        this.logger.error(`Failed to update/delete timesheet ${timesheetId}:`, timesheetError);
        return {
          success: false,
          message: `Timesheet entry was deleted, but failed to update/delete timesheet. Error: ${errorMsg}`,
          entryId,
          targetUserId,
          timesheetId,
          error: errorMsg,
        };
      }

      // Recalculate payable days for the cycle after deletion
      try {
        const cycleRange = this.getCycleRangeForWorkDate(new Date(timesheet.workDate));
        await this.recalculateAndPersistPayableDaysForCycle(
          db,
          orgId,
          targetUserId,
          cycleRange.cycleStart,
          cycleRange.cycleEnd,
          cycleRange.cycleKey,
          now,
        );
      } catch (payableDaysError) {
        const errorMsg = payableDaysError instanceof Error ? payableDaysError.message : 'Unknown error';
        this.logger.error(`Failed to recalculate payable days for user ${targetUserId}:`, payableDaysError);
        return {
          success: false,
          message: `Timesheet entry and record were deleted, but failed to recalculate payable days. Error: ${errorMsg}`,
          entryId,
          targetUserId,
          error: errorMsg,
          warning: 'Entry was deleted successfully. Please contact support to recalculate payable days.',
        };
      }

      // Try to reconcile comp-off credits after deletion
      if (totalHoursNum >= 0) {
        try {
          await this.leavesService.tryProcessCompOffForTimesheet(
            orgId,
            targetUserId,
            new Date(timesheet.workDate),
            timesheetId,
            totalHoursNum,
          );
        } catch (error) {
          // Log but don't fail the deletion if comp-off processing fails
          this.logger.warn(
            `Failed to auto-process comp off after deletion for timesheet ${timesheetId}:`,
            error,
          );
        }
      }

      const actorRole = this.getPrivilegedActorRole(actor?.roles ?? []);
      if (actorRole) {
        try {
          await this.auditService.createLog({
            orgId,
            actorUserId: actor?.id,
            actorRole,
            action: 'timesheet_deleted',
            subjectType: 'timesheet_deleted',
            targetUserId,
            prev: {
              projectId: existingEntry.projectId,
              hours: hoursToDelete,
              activities: existingEntry.taskDescription ?? null,
              status: existingEntry.status,
            },
            next: {
              status: 'deleted',
              remainingHours: totalHoursNum,
            },
          });
        } catch (auditError) {
          this.logger.warn(`Failed to create audit log for timesheet deletion:`, auditError);
          // Don't throw - deletion already succeeded
        }
      }

      return {
        success: true,
        message: 'Timesheet entry deleted permanently',
        timesheetDeleted: totalHoursNum === 0,
        remainingHours: totalHoursNum,
      };
    } catch (error) {
      // Catch any unexpected errors
      const errorMsg = error instanceof Error ? error.message : 'Unknown error occurred';
      this.logger.error(`Unexpected error deleting timesheet entry ${entryId}:`, error);
      return {
        success: false,
        message: `An unexpected error occurred while deleting the timesheet entry. Error: ${errorMsg}`,
        entryId,
        targetUserId,
        error: errorMsg,
      };
    }
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
}

