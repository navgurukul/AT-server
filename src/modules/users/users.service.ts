import { Injectable, NotFoundException } from '@nestjs/common';
import { and, count, eq, ilike, inArray, or } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import {
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

    const enrichedUsers = users.map((user) => ({
      ...user,
      roles: rolesByUser[user.id] ?? [],
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
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);

    if (!existing) {
      throw new NotFoundException(`User with id ${id} not found`);
    }

    const updateStatements: Partial<Pick<UpdateUserDto, 'managerId'>> = {};
    if (payload.managerId !== undefined) {
      updateStatements.managerId = payload.managerId;
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

    return {
      ...user,
      roles: Object.keys(groupedRoles),
      permissions: [
        ...new Set(userRoles.map((assignment) => assignment.permissions)),
      ],
    };
  }
}
