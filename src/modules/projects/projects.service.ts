import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
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
} from "drizzle-orm";

import { DatabaseService } from "../../database/database.service";
import {
  costRatesTable,
  departmentsTable,
  projectMembersTable,
  projectsTable,
  timesheetEntriesTable,
  timesheetsTable,
  usersTable,
} from "../../db/schema";
import { AssignMemberDto } from "./dto/assign-member.dto";
import { CreateProjectDto } from "./dto/create-project.dto";
import { UpdateProjectDto } from "./dto/update-project.dto";

interface ListProjectsParams {
  orgId?: number;
  status?: string;
  search?: string;
  departmentId?: number;
  projectManagerId?: number;
  page?: number;
  limit?: number;
}

const ALLOWED_PROJECT_STATUSES = [
  "active",
  "draft",
  "inactive",
  "on_hold",
  "completed",
  "archived",
] as const;

const PROJECT_SELECTION = {
  id: projectsTable.id,
  orgId: projectsTable.orgId,
  departmentId: projectsTable.departmentId,
  projectManagerId: projectsTable.projectManagerId,
  name: projectsTable.name,
  code: projectsTable.code,
  status: projectsTable.status,
  startDate: projectsTable.startDate,
  endDate: projectsTable.endDate,
  budgetCurrency: projectsTable.budgetCurrency,
  budgetAmount: projectsTable.budgetAmount,
  budgetAmountMinor: projectsTable.budgetAmountMinor,
  createdAt: projectsTable.createdAt,
  updatedAt: projectsTable.updatedAt,
  description: projectsTable.description,
  slackChannelId: projectsTable.slackChannelId,
  discordChannelId: projectsTable.discordChannelId,
};

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
        `Project code '${payload.code}' is already in use`
      );
    }

    const requestedStatus =
      payload.status && ALLOWED_PROJECT_STATUSES.includes(payload.status as any)
        ? (payload.status as (typeof ALLOWED_PROJECT_STATUSES)[number])
        : "active";

    const [department] = await db
      .select({
        id: departmentsTable.id,
        orgId: departmentsTable.orgId,
      })
      .from(departmentsTable)
      .where(eq(departmentsTable.id, payload.departmentId))
      .limit(1);

    if (!department) {
      throw new NotFoundException(
        `Department with id ${payload.departmentId} not found`
      );
    }

    if (Number(department.orgId) !== payload.orgId) {
      throw new BadRequestException(
        "Department does not belong to the provided organisation"
      );
    }

    const [manager] = await db
      .select({
        id: usersTable.id,
        orgId: usersTable.orgId,
        status: usersTable.status,
      })
      .from(usersTable)
      .where(eq(usersTable.id, payload.projectManagerId))
      .limit(1);

    if (!manager) {
      throw new NotFoundException(
        `Project manager with id ${payload.projectManagerId} not found`
      );
    }

    if (Number(manager.orgId) !== payload.orgId) {
      throw new BadRequestException(
        "Project manager must belong to the same organisation"
      );
    }

    const [project] = await db
      .insert(projectsTable)
      .values({
        orgId: payload.orgId,
        departmentId: payload.departmentId,
        projectManagerId: payload.projectManagerId,
        name: payload.name,
        code: payload.code,
        status: requestedStatus,
        startDate: payload.startDate ? new Date(payload.startDate) : null,
        endDate: payload.endDate ? new Date(payload.endDate) : null,
        budgetCurrency: payload.budgetCurrency ?? null,
        budgetAmountMinor:
          payload.budgetAmountMinor !== undefined
            ? payload.budgetAmountMinor.toString()
            : null,
        slackChannelId:
          payload.slackChannelId && payload.slackChannelId.trim().length > 0
            ? payload.slackChannelId.trim()
            : null,
        discordChannelId:
          payload.discordChannelId && payload.discordChannelId.trim().length > 0
            ? payload.discordChannelId.trim()
            : null,
      })
      .returning(PROJECT_SELECTION);

    const [hydrated] = await this.hydrateProjects(project ? [project] : []);
    return hydrated ?? project;
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
    if (
      params.status &&
      ALLOWED_PROJECT_STATUSES.includes(params.status as any)
    ) {
      filters.push(
        eq(
          projectsTable.status,
          params.status as (typeof ALLOWED_PROJECT_STATUSES)[number]
        )
      );
    }
    if (params.departmentId) {
      filters.push(eq(projectsTable.departmentId, params.departmentId));
    }
    if (params.projectManagerId) {
      filters.push(eq(projectsTable.projectManagerId, params.projectManagerId));
    }

    if (params.search) {
      const cleaned = params.search.trim();
      if (cleaned.length > 0) {
        const term = `%${cleaned.toLowerCase()}%`;
        filters.push(
          or(ilike(projectsTable.name, term), ilike(projectsTable.code, term))
        );
      }
    }

    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    const baseQuery = db.select(PROJECT_SELECTION).from(projectsTable);

    const filteredQuery = whereClause
      ? baseQuery.where(whereClause)
      : baseQuery;

    const projects = await filteredQuery
      .orderBy(desc(projectsTable.createdAt))
      .limit(limit)
      .offset(offset);

    const countQuery = whereClause
      ? db
          .select({ value: count(projectsTable.id) })
          .from(projectsTable)
          .where(whereClause)
      : db.select({ value: count(projectsTable.id) }).from(projectsTable);
    const [{ value: total }] = await countQuery;

    const enrichedProjects = await this.hydrateProjects(projects);

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
      .select(PROJECT_SELECTION)
      .from(projectsTable)
      .where(eq(projectsTable.id, id))
      .limit(1);

    if (!existing) {
      throw new NotFoundException("Project with id " + id + " not found");
    }

    if (payload.code && payload.code !== existing.code) {
      const [codeUsed] = await db
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(eq(projectsTable.code, payload.code))
        .limit(1);
      if (codeUsed) {
        throw new ConflictException(
          "Project code " + payload.code + " is already in use"
        );
      }
    }

    const updateValues: Partial<typeof projectsTable.$inferInsert> = {};

    if (payload.departmentId !== undefined) {
      const [department] = await db
        .select({
          id: departmentsTable.id,
          orgId: departmentsTable.orgId,
        })
        .from(departmentsTable)
        .where(eq(departmentsTable.id, payload.departmentId))
        .limit(1);

      if (!department) {
        throw new NotFoundException(
          "Department with id " + payload.departmentId + " not found"
        );
      }

      if (Number(department.orgId) !== Number(existing.orgId)) {
        throw new BadRequestException(
          "Department does not belong to the same organisation"
        );
      }

      updateValues.departmentId = payload.departmentId;
    }

    if (payload.projectManagerId !== undefined) {
      const [manager] = await db
        .select({
          id: usersTable.id,
          orgId: usersTable.orgId,
          status: usersTable.status,
        })
        .from(usersTable)
        .where(eq(usersTable.id, payload.projectManagerId))
        .limit(1);

      if (!manager) {
        throw new NotFoundException(
          "Project manager with id " + payload.projectManagerId + " not found"
        );
      }

      if (Number(manager.orgId) !== Number(existing.orgId)) {
        throw new BadRequestException(
          "Project manager must belong to the same organisation"
        );
      }

      updateValues.projectManagerId = payload.projectManagerId;
    }

    if (payload.name !== undefined) updateValues.name = payload.name;
    if (payload.code !== undefined) updateValues.code = payload.code;
    if (payload.status !== undefined) {
      if (!ALLOWED_PROJECT_STATUSES.includes(payload.status as any)) {
        throw new BadRequestException("Invalid project status");
      }
      updateValues.status =
        payload.status as (typeof ALLOWED_PROJECT_STATUSES)[number];
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
    if (payload.slackChannelId !== undefined) {
      updateValues.slackChannelId =
        payload.slackChannelId && payload.slackChannelId.trim().length > 0
          ? payload.slackChannelId.trim()
          : null;
    }
    if (payload.discordChannelId !== undefined) {
      updateValues.discordChannelId =
        payload.discordChannelId && payload.discordChannelId.trim().length > 0
          ? payload.discordChannelId.trim()
          : null;
    }

    let resultingProject = existing;

    if (Object.keys(updateValues).length > 0) {
      const [updated] = await db
        .update(projectsTable)
        .set({
          ...updateValues,
          updatedAt: new Date(),
        })
        .where(eq(projectsTable.id, id))
        .returning(PROJECT_SELECTION);

      if (updated) {
        resultingProject = updated;
      }
    }

    const [hydrated] = await this.hydrateProjects([resultingProject]);
    return hydrated ?? resultingProject;
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
      throw new NotFoundException(`User with id ${payload.userId} not found`);
    }

    const startDate = payload.startDate ? new Date(payload.startDate) : null;
    const endDate = payload.endDate ? new Date(payload.endDate) : null;

    const [existing] = await db
      .select({ userId: projectMembersTable.userId })
      .from(projectMembersTable)
      .where(
        and(
          eq(projectMembersTable.projectId, projectId),
          eq(projectMembersTable.userId, payload.userId)
        )
      )
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(projectMembersTable)
        .set({
          role: payload.role ?? projectMembersTable.role,
          allocationPct:
            payload.allocationPct !== undefined
              ? String(payload.allocationPct)
              : projectMembersTable.allocationPct,
          startDate,
          endDate,
        })
        .where(
          and(
            eq(projectMembersTable.projectId, projectId),
            eq(projectMembersTable.userId, payload.userId)
          )
        )
        .returning();
      return updated;
    }

    const [created] = await db
      .insert(projectMembersTable)
      .values({
        projectId,
        userId: payload.userId,
        role: payload.role ?? "contributor",
        allocationPct:
          payload.allocationPct !== undefined
            ? String(payload.allocationPct)
            : "100",
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
          eq(projectMembersTable.userId, userId)
        )
      )
      .returning();

    if (result.length === 0) {
      throw new NotFoundException(
        `Membership for user ${userId} on project ${projectId} not found`
      );
    }

    return { projectId, userId };
  }

  async getProjectCosts(
    projectId: number,
    params: { from?: string; to?: string }
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
      eq(timesheetsTable.state, "approved") ||
        eq(timesheetsTable.state, "locked"),
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
      `
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
    params: { from?: string; to?: string }
  ) {
    const db = this.database.connection;

    await this.ensureProjectExists(projectId);

    const { fromDate, toDateExclusive, toDate } = this.resolveDateRange(
      params.from,
      params.to
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
          ${toDateExclusive ? sql`AND t.work_date < ${toDateExclusive}` : sql``}
        GROUP BY t.user_id, u.name, u.email
        ORDER BY total_hours DESC
      `
    );

    const rows = (
      contributors.rows as {
        user_id: number;
        user_name: string | null;
        user_email: string | null;
        total_hours: string | null;
        first_entry: string | Date | null;
        last_entry: string | Date | null;
      }[]
    ).map((row) => ({
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
    params: { from?: string; to?: string }
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
      params.to
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
          ${toDateExclusive ? sql`AND t.work_date < ${toDateExclusive}` : sql``}
        GROUP BY t.work_date
        ORDER BY t.work_date
      `
    );

    const entries = await db.execute(
      sql`
        SELECT
          t.work_date::date AS work_date,
          te.hours_decimal AS hours_decimal
        FROM ${timesheetsTable} t
        INNER JOIN ${timesheetEntriesTable} te ON te.timesheet_id = t.id
        WHERE te.project_id = ${projectId}
          AND t.user_id = ${userId}
          AND t.state IN ('approved','locked')
          ${fromDate ? sql`AND t.work_date >= ${fromDate}` : sql``}
          ${toDateExclusive ? sql`AND t.work_date < ${toDateExclusive}` : sql``}
        ORDER BY t.work_date, te.id
      `
    );

    const daily = (
      dailyHours.rows as {
        work_date: string | Date;
        total_hours: string | null;
      }[]
    ).map((row) => ({
      date: new Date(row.work_date),
      totalHours: row.total_hours ? Number(row.total_hours) : 0,
    }));

    const detailedEntries = (
      entries.rows as {
        work_date: string | Date;
        hours_decimal: string | number | null;
      }[]
    ).map((row) => ({
      date: new Date(row.work_date),
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

  private async hydrateProjects(
    projects: Array<
      typeof projectsTable.$inferSelect & {
        departmentId: number | null;
        projectManagerId: number | null;
      }
    >
  ) {
    if (projects.length === 0) {
      return [];
    }

    const db = this.database.connection;
    const projectIds = projects.map((project) => project.id);

    const departmentIds = Array.from(
      new Set(
        projects
          .map((project) => project.departmentId)
          .filter((id): id is number => id !== null && id !== undefined)
      )
    );

    const projectManagerIds = Array.from(
      new Set(
        projects
          .map((project) => project.projectManagerId)
          .filter((id): id is number => id !== null && id !== undefined)
      )
    );

    const departments =
      departmentIds.length === 0
        ? []
        : await db
            .select({
              id: departmentsTable.id,
              name: departmentsTable.name,
              code: departmentsTable.code,
              description: departmentsTable.description,
            })
            .from(departmentsTable)
            .where(inArray(departmentsTable.id, departmentIds));

    const departmentsById = departments.reduce<
      Record<
        number,
        {
          id: number;
          name: string;
          code: string | null;
          description: string | null;
        }
      >
    >((acc, department) => {
      acc[Number(department.id)] = {
        id: Number(department.id),
        name: department.name,
        code: department.code ?? null,
        description: department.description ?? null,
      };
      return acc;
    }, {});

    const managers =
      projectManagerIds.length === 0
        ? []
        : await db
            .select({
              id: usersTable.id,
              name: usersTable.name,
              email: usersTable.email,
            })
            .from(usersTable)
            .where(inArray(usersTable.id, projectManagerIds));

    const managersById = managers.reduce<
      Record<
        number,
        {
          id: number;
          name: string | null;
          email: string | null;
        }
      >
    >((acc, manager) => {
      acc[Number(manager.id)] = {
        id: Number(manager.id),
        name: manager.name ?? null,
        email: manager.email ?? null,
      };
      return acc;
    }, {});

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
              eq(projectMembersTable.userId, usersTable.id)
            )
            .where(inArray(projectMembersTable.projectId, projectIds));

    const membersByProject = members.reduce<Record<number, typeof members>>(
      (acc, curr) => {
        acc[curr.projectId] = acc[curr.projectId] ?? [];
        acc[curr.projectId].push(curr);
        return acc;
      },
      {}
    );

    return projects.map((project) => ({
      ...project,
      department:
        project.departmentId !== null
          ? (departmentsById[project.departmentId] ?? null)
          : null,
      projectManager:
        project.projectManagerId !== null
          ? (managersById[project.projectManagerId] ?? null)
          : null,
      members: membersByProject[project.id] ?? [],
    }));
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
