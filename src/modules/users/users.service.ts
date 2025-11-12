import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { JWT } from 'google-auth-library';
import { hash } from 'bcryptjs';
import { and, count, eq, ilike, inArray, or } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import {
  departmentsTable,
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
        departmentId: usersTable.departmentId,
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

    let totalResultQuery = db
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

    const departmentIds = Array.from(
      new Set(
        users
          .map((user) => user.departmentId)
          .filter(
            (id): id is number => id !== null && id !== undefined,
          ),
      ),
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
    >((acc, curr) => {
      acc[curr.id] = {
        id: Number(curr.id),
        name: curr.name,
        code: curr.code ?? null,
        description: curr.description ?? null,
      };
      return acc;
    }, {});

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
      departmentId:
        user.departmentId !== null && user.departmentId !== undefined
          ? Number(user.departmentId)
          : null,
      department:
        user.departmentId !== null && user.departmentId !== undefined
          ? departmentsById[user.departmentId] ?? null
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
