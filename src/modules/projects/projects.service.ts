import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import {
  costRatesTable,
  projectMembersTable,
  projectsTable,
  timesheetEntriesTable,
  timesheetsTable,
  usersTable,
} from '../../db/schema';
import { AssignMemberDto } from './dto/assign-member.dto';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

interface ListProjectsParams {
  orgId?: number;
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class ProjectsService {
  constructor(private readonly database: DatabaseService) {}

  async createProject(payload: CreateProjectDto) {
    const db = this.database.connection;

    const existingCode = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.code, payload.code))
      .limit(1);

    if (existingCode.length > 0) {
      throw new ConflictException(
        `Project code '${payload.code}' is already in use`,
      );
    }

    const [project] = await db
      .insert(projectsTable)
      .values({
        orgId: payload.orgId,
        name: payload.name,
        code: payload.code,
        status: (payload.status ?? 'draft') as 'draft' | 'completed' | 'active' | 'on_hold' | 'archived',
        startDate: payload.startDate ? new Date(payload.startDate) : null,
        endDate: payload.endDate ? new Date(payload.endDate) : null,
        budgetCurrency: payload.budgetCurrency ?? null,
        budgetAmountMinor:
          payload.budgetAmountMinor !== undefined
            ? payload.budgetAmountMinor.toString()
            : null,
      })
      .returning();

    return project;
  }

  async listProjects(params: ListProjectsParams = {}) {
    const db = this.database.connection;
    const limit = params.limit && params.limit > 0 ? params.limit : 25;
    const page = params.page && params.page > 0 ? params.page : 1;
    const offset = (page - 1) * limit;

    const filters = [];
    if (params.orgId) {
      filters.push(eq(projectsTable.orgId, params.orgId));
    }
    if (params.status) {
      const allowedStatuses = ['active', 'draft', 'on_hold', 'completed', 'archived'] as const;
      if (allowedStatuses.includes(params.status as any)) {
        filters.push(eq(projectsTable.status, params.status as typeof allowedStatuses[number]));
      }
    }
    if (params.search) {
      const term = `%${params.search.toLowerCase()}%`;
      filters.push(
        or(
          ilike(projectsTable.name, term),
          ilike(projectsTable.code, term),
        ),
      );
    }

    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    const baseQuery = db.select({
      id: projectsTable.id,
      name: projectsTable.name,
      code: projectsTable.code,
      status: projectsTable.status,
      orgId: projectsTable.orgId,
      startDate: projectsTable.startDate,
      endDate: projectsTable.endDate,
      budgetCurrency: projectsTable.budgetCurrency,
      budgetAmountMinor: projectsTable.budgetAmountMinor,
      createdAt: projectsTable.createdAt,
      updatedAt: projectsTable.updatedAt,
    }).from(projectsTable);

    const filteredQuery = whereClause ? baseQuery.where(whereClause) : baseQuery;

    const projects = await filteredQuery
      .orderBy(desc(projectsTable.createdAt))
      .limit(limit)
      .offset(offset);

    const countQuery = whereClause
      ? db
          .select({ value: count(projectsTable.id) })
          .from(projectsTable)
          .where(whereClause)
      : db
          .select({ value: count(projectsTable.id) })
          .from(projectsTable);
    const [{ value: total }] = await countQuery;

    const projectIds = projects.map((project) => project.id);
    const members =
      projectIds.length === 0
        ? []
        : await db
            .select({
              projectId: projectMembersTable.projectId,
              userId: projectMembersTable.userId,
              role: projectMembersTable.role,
              allocationPct: projectMembersTable.allocationPct,
              startDate: projectMembersTable.startDate,
              endDate: projectMembersTable.endDate,
              userName: usersTable.name,
              userEmail: usersTable.email,
            })
            .from(projectMembersTable)
            .innerJoin(
              usersTable,
              eq(projectMembersTable.userId, usersTable.id),
            )
            .where(inArray(projectMembersTable.projectId, projectIds));

    const membersByProject = members.reduce<Record<number, typeof members>>(
      (acc, curr) => {
        acc[curr.projectId] = acc[curr.projectId] ?? [];
        acc[curr.projectId].push(curr);
        return acc;
      },
      {},
    );

    const enrichedProjects = projects.map((project) => ({
      ...project,
      members: membersByProject[project.id] ?? [],
    }));

    return {
      data: enrichedProjects,
      page,
      limit,
      total: Number(total),
    };
  }

  async updateProject(id: number, payload: UpdateProjectDto) {
    const db = this.database.connection;

    const [existing] = await db
      .select({ id: projectsTable.id, code: projectsTable.code })
      .from(projectsTable)
      .where(eq(projectsTable.id, id))
      .limit(1);

    if (!existing) {
      throw new NotFoundException(`Project with id ${id} not found`);
    }

    if (payload.code && payload.code !== existing.code) {
      const [codeUsed] = await db
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(eq(projectsTable.code, payload.code))
        .limit(1);
      if (codeUsed) {
        throw new ConflictException(
          `Project code '${payload.code}' is already in use`,
        );
      }
    }

    const updateValues: Partial<typeof projectsTable.$inferInsert> = {};
    if (payload.name !== undefined) updateValues.name = payload.name;
    if (payload.code !== undefined) updateValues.code = payload.code;
    if (payload.status !== undefined) {
      const allowedStatuses = ['active', 'draft', 'on_hold', 'completed', 'archived'] as const;
      if (allowedStatuses.includes(payload.status as any)) {
        updateValues.status = payload.status as typeof allowedStatuses[number];
      } else {
        updateValues.status = undefined;
      }
    }
    if (payload.startDate !== undefined) {
      updateValues.startDate = payload.startDate
        ? new Date(payload.startDate)
        : null;
    }
    if (payload.endDate !== undefined) {
      updateValues.endDate = payload.endDate ? new Date(payload.endDate) : null;
    }
    if (payload.budgetCurrency !== undefined) {
      updateValues.budgetCurrency = payload.budgetCurrency ?? null;
    }
    if (payload.budgetAmountMinor !== undefined) {
      updateValues.budgetAmountMinor = payload.budgetAmountMinor.toString();
    }

    if (Object.keys(updateValues).length === 0) {
      return existing;
    }

    const [updated] = await db
      .update(projectsTable)
      .set({
        ...updateValues,
        updatedAt: new Date(),
      })
      .where(eq(projectsTable.id, id))
      .returning();

    return updated;
  }

  async assignMember(projectId: number, payload: AssignMemberDto) {
    const db = this.database.connection;

    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);
    if (!project) {
      throw new NotFoundException(`Project with id ${projectId} not found`);
    }

    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, payload.userId))
      .limit(1);
    if (!user) {
      throw new NotFoundException(
        `User with id ${payload.userId} not found`,
      );
    }

    const startDate = payload.startDate ? new Date(payload.startDate) : null;
    const endDate = payload.endDate ? new Date(payload.endDate) : null;

    const [existing] = await db
      .select({ userId: projectMembersTable.userId })
      .from(projectMembersTable)
      .where(
        and(
          eq(projectMembersTable.projectId, projectId),
          eq(projectMembersTable.userId, payload.userId),
        ),
      )
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(projectMembersTable)
        .set({
          role: payload.role ?? projectMembersTable.role,
          allocationPct: payload.allocationPct !== undefined
            ? String(payload.allocationPct)
            : projectMembersTable.allocationPct,
          startDate,
          endDate,
        })
        .where(
          and(
            eq(projectMembersTable.projectId, projectId),
            eq(projectMembersTable.userId, payload.userId),
          ),
        )
        .returning();
      return updated;
    }

    const [created] = await db
      .insert(projectMembersTable)
      .values({
        projectId,
        userId: payload.userId,
        role: payload.role ?? 'contributor',
        allocationPct: payload.allocationPct !== undefined ? String(payload.allocationPct) : '100',
        startDate,
        endDate,
      })
      .returning();

    return created;
  }

  async removeMember(projectId: number, userId: number) {
    const db = this.database.connection;

    const result = await db
      .delete(projectMembersTable)
      .where(
        and(
          eq(projectMembersTable.projectId, projectId),
          eq(projectMembersTable.userId, userId),
        ),
      )
      .returning();

    if (result.length === 0) {
      throw new NotFoundException(
        `Membership for user ${userId} on project ${projectId} not found`,
      );
    }

    return { projectId, userId };
  }

  async getProjectCosts(
    projectId: number,
    params: { from?: string; to?: string },
  ) {
    const db = this.database.connection;

    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);

    if (!project) {
      throw new NotFoundException(`Project with id ${projectId} not found`);
    }

    const fromDate = params.from ? new Date(params.from) : undefined;
    const toDate = params.to ? new Date(params.to) : undefined;

    const dateClause = [
      eq(timesheetEntriesTable.projectId, projectId),
      eq(timesheetsTable.state, 'approved') ||
        eq(timesheetsTable.state, 'locked'),
    ];

    if (fromDate) {
      dateClause.push(sql`"t"."work_date" >= ${fromDate}`);
    }
    if (toDate) {
      dateClause.push(sql`"t"."work_date" <= ${toDate}`);
    }

    const costQuery = await db.execute(
      sql`
        SELECT
          SUM(te.hours_decimal)::numeric AS total_hours,
          SUM(te.hours_decimal * cr.hourly_cost_minor_currency)::numeric AS total_cost_minor
        FROM ${timesheetEntriesTable} AS te
        INNER JOIN ${timesheetsTable} AS t ON t.id = te.timesheet_id
        INNER JOIN ${costRatesTable} AS cr
          ON cr.user_id = t.user_id
         AND cr.effective_from <= t.work_date
         AND (cr.effective_to IS NULL OR cr.effective_to >= t.work_date)
        WHERE te.project_id = ${projectId}
          AND t.state IN ('approved', 'locked')
          ${fromDate ? sql`AND t.work_date >= ${fromDate}` : sql``}
          ${toDate ? sql`AND t.work_date <= ${toDate}` : sql``}
      `,
    );

    const row = costQuery.rows?.[0] as
      | { total_hours: string | null; total_cost_minor: string | null }
      | undefined;

    const totalHours = row?.total_hours ? Number(row.total_hours) : 0;
    const totalCostMinor = row?.total_cost_minor
      ? Number(row.total_cost_minor)
      : 0;

    return {
      projectId,
      period: {
        from: fromDate ?? null,
        to: toDate ?? null,
      },
      totalHours,
      totalCostMinor,
      averageHourlyCost:
        totalHours > 0 ? Math.round(totalCostMinor / totalHours) : 0,
    };
  }

  async getProjectContributors(
    projectId: number,
    params: { from?: string; to?: string },
  ) {
    const db = this.database.connection;

    await this.ensureProjectExists(projectId);

    const { fromDate, toDateExclusive, toDate } = this.resolveDateRange(
      params.from,
      params.to,
    );

    const contributors = await db.execute(
      sql`
        SELECT
          t.user_id AS user_id,
          u.name AS user_name,
          u.email AS user_email,
          COALESCE(SUM(te.hours_decimal), 0)::numeric AS total_hours,
          MIN(t.work_date)::date AS first_entry,
          MAX(t.work_date)::date AS last_entry
        FROM ${timesheetsTable} t
        INNER JOIN ${timesheetEntriesTable} te ON te.timesheet_id = t.id
        INNER JOIN ${usersTable} u ON u.id = t.user_id
        WHERE te.project_id = ${projectId}
          AND t.state IN ('approved','locked')
          ${fromDate ? sql`AND t.work_date >= ${fromDate}` : sql``}
          ${
            toDateExclusive ? sql`AND t.work_date < ${toDateExclusive}` : sql``
          }
        GROUP BY t.user_id, u.name, u.email
        ORDER BY total_hours DESC
      `,
    );

    const rows = (contributors.rows as {
      user_id: number;
      user_name: string | null;
      user_email: string | null;
      total_hours: string | null;
      first_entry: string | Date | null;
      last_entry: string | Date | null;
    }[]).map((row) => ({
      userId: Number(row.user_id),
      userName: row.user_name ?? null,
      userEmail: row.user_email ?? null,
      totalHours: row.total_hours ? Number(row.total_hours) : 0,
      firstEntry: row.first_entry ? new Date(row.first_entry) : null,
      lastEntry: row.last_entry ? new Date(row.last_entry) : null,
    }));

    return {
      projectId,
      period: {
        from: fromDate ?? null,
        to: toDate,
      },
      contributors: rows,
    };
  }

  async getProjectUserHours(
    projectId: number,
    userId: number,
    params: { from?: string; to?: string },
  ) {
    const db = this.database.connection;

    await this.ensureProjectExists(projectId);

    const [user] = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const { fromDate, toDateExclusive, toDate } = this.resolveDateRange(
      params.from,
      params.to,
    );

    const dailyHours = await db.execute(
      sql`
        SELECT
          t.work_date::date AS work_date,
          COALESCE(SUM(te.hours_decimal), 0)::numeric AS total_hours
        FROM ${timesheetsTable} t
        INNER JOIN ${timesheetEntriesTable} te ON te.timesheet_id = t.id
        WHERE te.project_id = ${projectId}
          AND t.user_id = ${userId}
          AND t.state IN ('approved','locked')
          ${fromDate ? sql`AND t.work_date >= ${fromDate}` : sql``}
          ${
            toDateExclusive ? sql`AND t.work_date < ${toDateExclusive}` : sql``
          }
        GROUP BY t.work_date
        ORDER BY t.work_date
      `,
    );

    const entries = await db.execute(
      sql`
        SELECT
          t.work_date::date AS work_date,
          te.task_title AS task_title,
          te.hours_decimal AS hours_decimal
        FROM ${timesheetsTable} t
        INNER JOIN ${timesheetEntriesTable} te ON te.timesheet_id = t.id
        WHERE te.project_id = ${projectId}
          AND t.user_id = ${userId}
          AND t.state IN ('approved','locked')
          ${fromDate ? sql`AND t.work_date >= ${fromDate}` : sql``}
          ${
            toDateExclusive ? sql`AND t.work_date < ${toDateExclusive}` : sql``
          }
        ORDER BY t.work_date, te.id
      `,
    );

    const daily = (dailyHours.rows as {
      work_date: string | Date;
      total_hours: string | null;
    }[]).map((row) => ({
      date: new Date(row.work_date),
      totalHours: row.total_hours ? Number(row.total_hours) : 0,
    }));

    const detailedEntries = (entries.rows as {
      work_date: string | Date;
      task_title: string | null;
      hours_decimal: string | number | null;
    }[]).map((row) => ({
      date: new Date(row.work_date),
      taskTitle: row.task_title ?? null,
      hours: Number(row.hours_decimal ?? 0),
    }));

    const totalHours = daily.reduce((acc, row) => acc + row.totalHours, 0);

    return {
      projectId,
      user: {
        id: Number(user.id),
        name: user.name,
        email: user.email,
      },
      period: {
        from: fromDate ?? null,
        to: toDate,
      },
      totals: {
        totalHours: Number(totalHours.toFixed(2)),
      },
      daily,
      entries: detailedEntries,
    };
  }

  private resolveDateRange(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    const toDateExclusive = toDate
      ? new Date(toDate.getTime() + 24 * 60 * 60 * 1000)
      : undefined;

    return { fromDate, toDateExclusive, toDate };
  }

  private async ensureProjectExists(projectId: number) {
    const db = this.database.connection;
    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
  }
}
