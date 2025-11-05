import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, eq, ilike, inArray, or } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import {
  departmentsTable,
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

    const updateStatements: Partial<{
      managerId: number;
      departmentId: number | null;
    }> = {};
    if (payload.managerId !== undefined) {
      updateStatements.managerId = payload.managerId;
    }

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
          `Department with id ${payload.departmentId} not found`,
        );
      }

      if (department.orgId !== existing.orgId) {
        throw new BadRequestException(
          'Department belongs to a different organisation',
        );
      }

      updateStatements.departmentId = department.id;
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
        departmentId: usersTable.departmentId,
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

    let department:
      | {
          id: number;
          name: string;
          code: string | null;
          description: string | null;
        }
      | null = null;
    if (user.departmentId !== null && user.departmentId !== undefined) {
      const [departmentRow] = await db
        .select({
          id: departmentsTable.id,
          name: departmentsTable.name,
          code: departmentsTable.code,
          description: departmentsTable.description,
        })
        .from(departmentsTable)
        .where(eq(departmentsTable.id, user.departmentId))
        .limit(1);

      if (departmentRow) {
        department = {
          id: Number(departmentRow.id),
          name: departmentRow.name,
          code: departmentRow.code ?? null,
          description: departmentRow.description ?? null,
        };
      }
    }

    return {
      ...user,
      managerId:
        user.managerId !== null && user.managerId !== undefined
          ? Number(user.managerId)
          : null,
      departmentId:
        user.departmentId !== null && user.departmentId !== undefined
          ? Number(user.departmentId)
          : null,
      department,
      roles: Object.keys(groupedRoles),
      permissions: [
        ...new Set(userRoles.map((assignment) => assignment.permissions)),
      ],
    };
  }
}
