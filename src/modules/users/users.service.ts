import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { JWT } from 'google-auth-library';
import { createHash } from 'crypto';
import { and, count, eq, ilike, inArray, isNotNull, or } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import {
  employeeDepartmentsTable,
  permissionsTable,
  rolePermissionsTable,
  rolesTable,
  userRolesTable,
  usersTable,
} from '../../db/schema';
import { UpdateUserDto } from './dto/update-user.dto';

interface SearchUsersParams {
  managerId?: number;
  role?: string;
  query?: string;
  page?: number;
  limit?: number;
}

export interface SheetSyncResult {
  created: number;
  updated: number;
  missingManagers: string[];
}

export interface ManagerRoleSyncResult {
  roleKey: string;
  totalManagers: number;
  newlyAssigned: number;
  alreadyAssigned: number;
}

@Injectable()
export class UsersService {
  constructor(private readonly database: DatabaseService) {}

  async searchUsers(params: SearchUsersParams) {
    const db = this.database.connection;
    const limit = params.limit && params.limit > 0 ? params.limit : 25;
    const page = params.page && params.page > 0 ? params.page : 1;
    const offset = (page - 1) * limit;

    const filters = [];

    if (params.managerId) {
      filters.push(eq(usersTable.managerId, params.managerId));
    }

    if (params.query) {
      const q = `%${params.query.toLowerCase()}%`;
      filters.push(
        or(ilike(usersTable.name, q), ilike(usersTable.email, q)),
      );
    }

    let roleFilteredUserIds: number[] | undefined;
    if (params.role) {
      const role = await db
        .select({ id: rolesTable.id })
        .from(rolesTable)
        .where(eq(rolesTable.key, params.role))
        .limit(1);

      if (role.length === 0) {
        return { data: [], page, limit, total: 0 };
      }

      const userRoleRows = await db
        .select({ userId: userRolesTable.userId })
        .from(userRolesTable)
        .where(eq(userRolesTable.roleId, role[0].id));

      roleFilteredUserIds = userRoleRows.map((row) => row.userId);
      if (roleFilteredUserIds.length === 0) {
        return { data: [], page, limit, total: 0 };
      }
      filters.push(inArray(usersTable.id, roleFilteredUserIds));
    }

    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    const baseUsersQuery = db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        orgId: usersTable.orgId,
        status: usersTable.status,
        managerId: usersTable.managerId,
        employeeDepartmentId: usersTable.employeeDepartmentId,
        workLocationType: usersTable.workLocationType,
        dateOfJoining: usersTable.dateOfJoining,
        employmentType: usersTable.employmentType,
        employmentStatus: usersTable.employmentStatus,
        dateOfExit: usersTable.dateOfExit,
        slackId: usersTable.slackId,
        alumniStatus: usersTable.alumniStatus,
        gender: usersTable.gender,
        discordId: usersTable.discordId,
        rolePrimary: usersTable.rolePrimary,
        avatarUrl: usersTable.avatarUrl,
        createdAt: usersTable.createdAt,
        updatedAt: usersTable.updatedAt,
      })
      .from(usersTable);

    const usersQuery = whereClause
      ? baseUsersQuery.where(whereClause)
      : baseUsersQuery;

    const users = await usersQuery.limit(limit).offset(offset);

    const totalResultQuery = db
      .select({ value: count(usersTable.id) })
      .from(usersTable);
    const totalResult = await (
      whereClause
        ? totalResultQuery.where(whereClause)
        : totalResultQuery
    );

    const userIds = users.map((user) => user.id);
    const roleAssignments =
      userIds.length === 0
        ? []
        : await db
            .select({
              userId: userRolesTable.userId,
              roleKey: rolesTable.key,
            })
            .from(userRolesTable)
            .innerJoin(rolesTable, eq(userRolesTable.roleId, rolesTable.id))
            .where(inArray(userRolesTable.userId, userIds));

    const rolesByUser = roleAssignments.reduce<Record<number, string[]>>(
      (acc, curr) => {
        acc[curr.userId] = acc[curr.userId] ?? [];
        acc[curr.userId].push(curr.roleKey);
        return acc;
      },
      {},
    );

    const employeeDepartmentIds = Array.from(
      new Set(
        users
          .map((user) => user.employeeDepartmentId)
          .filter(
            (id): id is number => id !== null && id !== undefined,
          ),
      ),
    );

    const employeeDepartments =
      employeeDepartmentIds.length === 0
        ? []
        : await db
            .select({
              id: employeeDepartmentsTable.id,
              name: employeeDepartmentsTable.name,
              code: employeeDepartmentsTable.code,
              description: employeeDepartmentsTable.description,
            })
            .from(employeeDepartmentsTable)
            .where(inArray(employeeDepartmentsTable.id, employeeDepartmentIds));

    const employeeDepartmentsById = employeeDepartments.reduce<
      Record<
        number,
        { id: number; name: string; code: string | null; description: string | null }
      >
    >((acc, curr) => {
      acc[curr.id] = {
        id: Number(curr.id),
        name: curr.name,
        code: curr.code ?? null,
        description: curr.description ?? null,
      };
      return acc;
    }, {});

    const enrichedUsers = users.map((user) => ({
      ...user,
      roles: rolesByUser[user.id] ?? [],
      managerId:
        user.managerId !== null && user.managerId !== undefined
          ? Number(user.managerId)
          : null,
      employeeDepartmentId:
        user.employeeDepartmentId !== null && user.employeeDepartmentId !== undefined
          ? Number(user.employeeDepartmentId)
          : null,
      employeeDepartment:
        user.employeeDepartmentId !== null && user.employeeDepartmentId !== undefined
          ? employeeDepartmentsById[user.employeeDepartmentId] ?? null
          : null,
    }));

    const total = Number(totalResult[0]?.value ?? 0);

    return {
      data: enrichedUsers,
      page,
      limit,
      total,
    };
  }

  async updateUser(id: number, payload: UpdateUserDto) {
    const db = this.database.connection;

    const [existing] = await db
      .select({
        id: usersTable.id,
        orgId: usersTable.orgId,
      })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);

    if (!existing) {
      throw new NotFoundException(`User with id ${id} not found`);
    }

    const updateStatements: Record<string, unknown> = {};
    if (payload.managerId !== undefined) {
      updateStatements.managerId = payload.managerId;
    }

    if (payload.employeeDepartmentId !== undefined) {
      if (payload.employeeDepartmentId === null) {
        updateStatements.employeeDepartmentId = null;
      } else {
        const [employeeDepartment] = await db
          .select({ id: employeeDepartmentsTable.id })
          .from(employeeDepartmentsTable)
          .where(eq(employeeDepartmentsTable.id, payload.employeeDepartmentId))
          .limit(1);

        if (!employeeDepartment) {
          throw new NotFoundException(
            `Employee department with id ${payload.employeeDepartmentId} not found`,
          );
        }

        updateStatements.employeeDepartmentId = employeeDepartment.id;
      }
    }

    if (payload.workLocationType !== undefined) {
      updateStatements.workLocationType =
        payload.workLocationType?.trim().length ? payload.workLocationType.trim() : null;
    }

    if (payload.employmentType !== undefined) {
      updateStatements.employmentType =
        payload.employmentType?.trim().length ? payload.employmentType.trim() : null;
    }

    if (payload.employmentStatus !== undefined) {
      updateStatements.employmentStatus =
        payload.employmentStatus?.trim().length ? payload.employmentStatus.trim() : null;
    }

    if (payload.slackId !== undefined) {
      updateStatements.slackId =
        payload.slackId?.trim().length ? payload.slackId.trim() : null;
    }

    if (payload.alumniStatus !== undefined) {
      updateStatements.alumniStatus =
        payload.alumniStatus?.trim().length ? payload.alumniStatus.trim() : null;
    }

    if (payload.gender !== undefined) {
      updateStatements.gender =
        payload.gender?.trim().length ? payload.gender.trim() : null;
    }

    if (payload.discordId !== undefined) {
      updateStatements.discordId =
        payload.discordId?.trim().length ? payload.discordId.trim() : null;
    }

    if (payload.dateOfJoining !== undefined) {
      updateStatements.dateOfJoining = payload.dateOfJoining
        ? new Date(payload.dateOfJoining)
        : null;
    }

    if (payload.dateOfExit !== undefined) {
      updateStatements.dateOfExit = payload.dateOfExit
        ? new Date(payload.dateOfExit)
        : null;
    }

    if (Object.keys(updateStatements).length > 0) {
      await db
        .update(usersTable)
        .set(updateStatements)
        .where(eq(usersTable.id, id));
    }

    if (payload.roles) {
      const roles = await db
        .select({
          id: rolesTable.id,
          key: rolesTable.key,
        })
        .from(rolesTable)
        .where(inArray(rolesTable.key, payload.roles));

      const missingRoles = payload.roles.filter(
        (roleKey) => !roles.some((role) => role.key === roleKey),
      );
      if (missingRoles.length > 0) {
        throw new NotFoundException(
          `Roles not found: ${missingRoles.join(', ')}`,
        );
      }

      await db
        .delete(userRolesTable)
        .where(eq(userRolesTable.userId, id));

      if (roles.length > 0) {
        await db.insert(userRolesTable).values(
          roles.map((role) => ({
            roleId: role.id,
            userId: id,
          })),
        );
      }
    }

    const [user] = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        orgId: usersTable.orgId,
        status: usersTable.status,
        managerId: usersTable.managerId,
        employeeDepartmentId: usersTable.employeeDepartmentId,
        workLocationType: usersTable.workLocationType,
        dateOfJoining: usersTable.dateOfJoining,
        employmentType: usersTable.employmentType,
        employmentStatus: usersTable.employmentStatus,
        dateOfExit: usersTable.dateOfExit,
        slackId: usersTable.slackId,
        alumniStatus: usersTable.alumniStatus,
        gender: usersTable.gender,
        discordId: usersTable.discordId,
      })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);

    const userRoles = await db
      .select({
        roleKey: rolesTable.key,
        permissions: permissionsTable.key,
      })
      .from(userRolesTable)
      .innerJoin(rolesTable, eq(userRolesTable.roleId, rolesTable.id))
      .innerJoin(
        rolePermissionsTable,
        eq(rolePermissionsTable.roleId, rolesTable.id),
      )
      .innerJoin(
        permissionsTable,
        eq(rolePermissionsTable.permissionId, permissionsTable.id),
      )
      .where(eq(userRolesTable.userId, id));

    const groupedRoles = userRoles.reduce<Record<string, string[]>>(
      (acc, curr) => {
        acc[curr.roleKey] = acc[curr.roleKey] ?? [];
        acc[curr.roleKey].push(curr.permissions);
        return acc;
      },
      {},
    );

    let employeeDepartment:
      | {
          id: number;
          name: string;
          code: string | null;
          description: string | null;
        }
      | null = null;
    if (
      user.employeeDepartmentId !== null &&
      user.employeeDepartmentId !== undefined
    ) {
      const [employeeDepartmentRow] = await db
        .select({
          id: employeeDepartmentsTable.id,
          name: employeeDepartmentsTable.name,
          code: employeeDepartmentsTable.code,
          description: employeeDepartmentsTable.description,
        })
        .from(employeeDepartmentsTable)
        .where(eq(employeeDepartmentsTable.id, user.employeeDepartmentId))
        .limit(1);

      if (employeeDepartmentRow) {
        employeeDepartment = {
          id: Number(employeeDepartmentRow.id),
          name: employeeDepartmentRow.name,
          code: employeeDepartmentRow.code ?? null,
          description: employeeDepartmentRow.description ?? null,
        };
      }
    }

    return {
      ...user,
      managerId:
        user.managerId !== null && user.managerId !== undefined
          ? Number(user.managerId)
          : null,
      employeeDepartmentId:
        user.employeeDepartmentId !== null &&
        user.employeeDepartmentId !== undefined
          ? Number(user.employeeDepartmentId)
          : null,
      employeeDepartment,
      roles: Object.keys(groupedRoles),
      permissions: [
        ...new Set(userRoles.map((assignment) => assignment.permissions)),
      ],
    };
  }

  async syncUsersFromSheet(): Promise<SheetSyncResult> {
    const db = this.database.connection;

    const serviceAccountEmail = process.env.GOOGLE_SA_CLIENT_EMAIL;
    const serviceAccountKeyRaw = process.env.GOOGLE_SA_PRIVATE_KEY;
    const spreadsheetId =
      process.env.GOOGLE_SHEETS_SPREADSHEET_ID ??
      '1sHDVjrejDg9T2TT0qGt853nU1EXBbOncMv61HB7bqD8';
    const range =
      process.env.GOOGLE_SHEETS_RANGE ?? 'PnC data for AT!A2:O1000';

    if (!serviceAccountEmail || !serviceAccountKeyRaw) {
      throw new BadRequestException(
        'Google service-account credentials are not configured',
      );
    }

    const serviceAccountKey = serviceAccountKeyRaw.replace(/\\n/g, '\n');

    const jwtClient = new JWT({
      email: serviceAccountEmail,
      key: serviceAccountKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const { access_token: accessToken } = await jwtClient.authorize();

    if (!accessToken) {
      throw new BadRequestException('Unable to obtain Google access token');
    }

    const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
      range,
    )}?majorDimension=ROWS`;
    const sheetResponse = await fetch(sheetUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!sheetResponse.ok) {
      throw new BadRequestException(
        `Unable to fetch Google Sheet data (${sheetResponse.status})`,
      );
    }

    const sheetData = (await sheetResponse.json()) as {
      values?: string[][];
    };

    const rows = sheetData.values ?? [];
    if (rows.length === 0) {
      return { created: 0, updated: 0, missingManagers: [] };
    }

    const existingUsers = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
      })
      .from(usersTable);

    const userByEmail = new Map(
      existingUsers.map((user) => [user.email.toLowerCase(), user]),
    );

    const employeeDepartmentRows = await db
      .select({
        id: employeeDepartmentsTable.id,
        name: employeeDepartmentsTable.name,
      })
      .from(employeeDepartmentsTable);

    const employeeDepartmentCache = new Map(
      employeeDepartmentRows.map((dept) => [dept.name.toLowerCase(), dept.id]),
    );

    const ensureEmployeeDepartmentId = async (name: string) => {
      const key = name.toLowerCase();
      if (employeeDepartmentCache.has(key)) {
        return employeeDepartmentCache.get(key)!;
      }
      const [createdDept] = await db
        .insert(employeeDepartmentsTable)
        .values({ name })
        .returning({ id: employeeDepartmentsTable.id });
      const id = Number(createdDept.id);
      employeeDepartmentCache.set(key, id);
      return id;
    };

    const COL_EMAIL = 0;
    const COL_NAME = 1;
    const COL_WORK_LOCATION = 2;
    const COL_EMPLOYEE_DEPARTMENT = 3;
    const COL_DATE_OF_JOINING = 5;
    const COL_EMPLOYMENT_TYPE = 6;
    const COL_EMPLOYMENT_STATUS = 7;
    const COL_DATE_OF_EXIT = 8;
    const COL_SLACK_ID = 9;
    const COL_REPORTING_MANAGER_EMAIL = 11;
    const COL_ALUMNI = 12;
    const COL_GENDER = 13;
    const COL_DISCORD = 14;

    const departmentNamesToEnsure = new Set<string>();
    for (const row of rows) {
      const deptName = this.normalizeSheetString(row?.[COL_EMPLOYEE_DEPARTMENT]);
      if (deptName) {
        departmentNamesToEnsure.add(deptName);
      }
    }

    for (const deptName of departmentNamesToEnsure) {
      await ensureEmployeeDepartmentId(deptName);
    }

    let created = 0;
    let updated = 0;
    const missingManagers = new Set<string>();

    const ensureUser = async (
      email: string,
      displayName: string | null,
      employmentStatus: string | undefined,
    ) => {
      const normalizedEmail = email.toLowerCase();
      const existing = userByEmail.get(normalizedEmail);
      if (existing) {
        return existing;
      }

      const name = displayName?.trim().length
        ? displayName.trim()
        : normalizedEmail;

      const status = this.isActiveEmployment(employmentStatus)
        ? 'active'
        : 'inactive';

      const now = new Date();
      const [createdUser] = await db
        .insert(usersTable)
        .values({
          orgId: 1,
          email: normalizedEmail,
          name,
          passwordHash: this.generatePlaceholderPassword(normalizedEmail),
          status,
          rolePrimary: 'employee',
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          id: usersTable.id,
          email: usersTable.email,
        });

      const record = {
        id: Number(createdUser.id),
        email: createdUser.email,
      };
      userByEmail.set(normalizedEmail, record);
      created += 1;
      return record;
    };

    for (const row of rows) {
      if (!row || row.length === 0) {
        continue;
      }

      const emailCell = this.normalizeSheetString(row[COL_EMAIL]);
      if (!emailCell) {
        continue;
      }

      const nameCell = this.normalizeSheetString(row[COL_NAME]);
      const employmentStatus = this.normalizeSheetString(
        row[COL_EMPLOYMENT_STATUS],
      );
      const userRecord = await ensureUser(
        emailCell,
        nameCell ?? null,
        employmentStatus ?? undefined,
      );

      const updatePayload: Record<string, unknown> = {};

      const workLocationType = this.normalizeSheetString(
        row[COL_WORK_LOCATION],
      );
      if (workLocationType !== undefined) {
        updatePayload.workLocationType = workLocationType;
      }

      const employeeDepartmentName = this.normalizeSheetString(
        row[COL_EMPLOYEE_DEPARTMENT],
      );
      if (employeeDepartmentName !== undefined) {
        if (employeeDepartmentName === null) {
          updatePayload.employeeDepartmentId = null;
        } else {
          const deptId = await ensureEmployeeDepartmentId(
            employeeDepartmentName,
          );
          updatePayload.employeeDepartmentId = deptId;
        }
      }

      const dateOfJoining = this.parseSheetDate(row[COL_DATE_OF_JOINING]);
      if (dateOfJoining !== undefined) {
        updatePayload.dateOfJoining = dateOfJoining;
      }

      const employmentType = this.normalizeSheetString(
        row[COL_EMPLOYMENT_TYPE],
      );
      if (employmentType !== undefined) {
        updatePayload.employmentType = employmentType;
      }

      if (employmentStatus !== undefined) {
        updatePayload.employmentStatus = employmentStatus;
        updatePayload.status = this.isActiveEmployment(employmentStatus)
          ? 'active'
          : 'inactive';
      }

      const dateOfExit = this.parseSheetDate(row[COL_DATE_OF_EXIT]);
      if (dateOfExit !== undefined) {
        updatePayload.dateOfExit = dateOfExit;
      }

      const slackId = this.normalizeSheetString(row[COL_SLACK_ID]);
      if (slackId !== undefined) {
        updatePayload.slackId = slackId;
      }

      const managerEmailCell = this.normalizeSheetString(
        row[COL_REPORTING_MANAGER_EMAIL],
      );
      if (managerEmailCell !== undefined) {
        if (managerEmailCell === null) {
          updatePayload.managerId = null;
        } else {
          try {
            const managerRecord = await ensureUser(
              managerEmailCell,
              null,
              'active',
            );
            updatePayload.managerId = managerRecord.id;
          } catch (error) {
            missingManagers.add(managerEmailCell);
          }
        }
      }

      const alumniStatus = this.normalizeSheetString(row[COL_ALUMNI]);
      if (alumniStatus !== undefined) {
        updatePayload.alumniStatus = alumniStatus;
      }

      const gender = this.normalizeSheetString(row[COL_GENDER]);
      if (gender !== undefined) {
        updatePayload.gender = gender;
      }

      const discordId = this.normalizeSheetString(row[COL_DISCORD]);
      if (discordId !== undefined) {
        updatePayload.discordId = discordId;
      }

      if (Object.keys(updatePayload).length === 0) {
        continue;
      }

      await db
        .update(usersTable)
        .set(updatePayload)
        .where(eq(usersTable.id, userRecord.id));
      updated += 1;
    }

    await this.ensureReportingManagersHaveManagerRole();

    return {
      created,
      updated,
      missingManagers: Array.from(missingManagers),
    };
  }

  async ensureReportingManagersHaveManagerRole(): Promise<ManagerRoleSyncResult> {
    const db = this.database.connection;

    const [managerRole] = await db
      .select({
        id: rolesTable.id,
        key: rolesTable.key,
      })
      .from(rolesTable)
      .where(eq(rolesTable.key, 'manager'))
      .limit(1);

    if (!managerRole) {
      throw new NotFoundException("Role with key 'manager' not found");
    }

    const managerRows = await db
      .select({
        managerId: usersTable.managerId,
      })
      .from(usersTable)
      .where(isNotNull(usersTable.managerId));

    const managerIds = [
      ...new Set(
        managerRows
          .map((row) =>
            row.managerId === null || row.managerId === undefined
              ? null
              : Number(row.managerId),
          )
          .filter((value): value is number => typeof value === 'number' && !Number.isNaN(value)),
      ),
    ];

    if (managerIds.length === 0) {
      return {
        roleKey: managerRole.key,
        totalManagers: 0,
        newlyAssigned: 0,
        alreadyAssigned: 0,
      };
    }

    const existingAssignments = await db
      .select({
        userId: userRolesTable.userId,
      })
      .from(userRolesTable)
      .where(
        and(
          eq(userRolesTable.roleId, managerRole.id),
          inArray(userRolesTable.userId, managerIds),
        ),
      );

    const assignedSet = new Set(existingAssignments.map((assignment) => assignment.userId));
    const missingManagerIds = managerIds.filter((id) => !assignedSet.has(id));

    if (missingManagerIds.length > 0) {
      await db
        .insert(userRolesTable)
        .values(
          missingManagerIds.map((userId) => ({
            userId,
            roleId: managerRole.id,
          })),
        )
        .onConflictDoNothing();
    }

    return {
      roleKey: managerRole.key,
      totalManagers: managerIds.length,
      newlyAssigned: missingManagerIds.length,
      alreadyAssigned: managerIds.length - missingManagerIds.length,
    };
  }

  private normalizeSheetString(value?: string): string | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed;
  }

  private parseSheetDate(value?: string): Date | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const numericValue = Number(trimmed);
    if (!Number.isNaN(numericValue)) {
      const excelEpoch = new Date(Date.UTC(1899, 11, 30));
      return new Date(excelEpoch.getTime() + numericValue * 86400000);
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  }

  private isActiveEmployment(status?: string | null): boolean {
    if (!status) {
      return false;
    }
    return status.trim().toLowerCase() === 'active';
  }

  private generatePlaceholderPassword(seed: string): string {
    return createHash('sha256').update(`navtrack:${seed}`).digest('hex');
  }
}
