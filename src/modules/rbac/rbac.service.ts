import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { asc, desc, eq, inArray } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import {
  permissionsTable,
  rolePermissionsTable,
  rolesTable,
  userRolesTable,
  usersTable,
} from '../../db/schema';

export interface RoleWithPermissions {
  id: number;
  key: string;
  name: string;
  permissions: string[];
}

@Injectable()
export class RbacService {
  constructor(private readonly database: DatabaseService) {}

  async listRoles(): Promise<RoleWithPermissions[]> {
    const db = this.database.connection;

    const roles = await db
      .select({
        id: rolesTable.id,
        key: rolesTable.key,
        name: rolesTable.name,
      })
      .from(rolesTable)
      .orderBy(asc(rolesTable.key));

    if (roles.length === 0) {
      return [];
    }

    const roleIds = roles.map((role) => role.id);
    const assignments =
      roleIds.length === 0
        ? []
        : await db
            .select({
              roleId: rolePermissionsTable.roleId,
              permissionKey: permissionsTable.key,
            })
            .from(rolePermissionsTable)
            .innerJoin(
              permissionsTable,
              eq(rolePermissionsTable.permissionId, permissionsTable.id),
            )
            .where(inArray(rolePermissionsTable.roleId, roleIds))
            .orderBy(
              asc(rolePermissionsTable.roleId),
              asc(permissionsTable.key),
            );

    const permissionsByRole = assignments.reduce<Record<number, string[]>>(
      (acc, curr) => {
        if (!acc[curr.roleId]) {
          acc[curr.roleId] = [];
        }
        acc[curr.roleId].push(curr.permissionKey);
        return acc;
      },
      {},
    );

    return roles.map((role) => ({
      ...role,
      permissions: permissionsByRole[role.id] ?? [],
    }));
  }

  async listPermissions() {
    const db = this.database.connection;

    return db
      .select({
        id: permissionsTable.id,
        key: permissionsTable.key,
        description: permissionsTable.description,
      })
      .from(permissionsTable)
      .orderBy(asc(permissionsTable.key));
  }

  async assignPermissionsToRole(roleKey: string, permissionKeys: string[]) {
    const db = this.database.connection;
    const uniqueKeys = [...new Set(permissionKeys.map((key) => key.trim()))].filter(
      (key) => key.length > 0,
    );

    return db.transaction(async (tx) => {
      const [role] = await tx
        .select({
          id: rolesTable.id,
          key: rolesTable.key,
          name: rolesTable.name,
        })
        .from(rolesTable)
        .where(eq(rolesTable.key, roleKey))
        .limit(1);

      if (!role) {
        throw new NotFoundException(`Role with key '${roleKey}' not found`);
      }

      if (uniqueKeys.length > 0) {
        const dbPermissions = await tx
          .select({
            id: permissionsTable.id,
            key: permissionsTable.key,
          })
          .from(permissionsTable)
          .where(inArray(permissionsTable.key, uniqueKeys));

        const missingKeys = uniqueKeys.filter(
          (key) => !dbPermissions.some((perm) => perm.key === key),
        );
        if (missingKeys.length > 0) {
          throw new NotFoundException(
            `Permissions not found: ${missingKeys.join(', ')}`,
          );
        }

        await tx
          .delete(rolePermissionsTable)
          .where(eq(rolePermissionsTable.roleId, role.id));

        if (dbPermissions.length > 0) {
          await tx
            .insert(rolePermissionsTable)
            .values(
              dbPermissions.map((permission) => ({
                roleId: role.id,
                permissionId: permission.id,
              })),
            )
            .onConflictDoNothing();
        }
      } else {
        await tx
          .delete(rolePermissionsTable)
          .where(eq(rolePermissionsTable.roleId, role.id));
      }

      const assignments = await tx
        .select({
          permissionKey: permissionsTable.key,
        })
        .from(rolePermissionsTable)
        .innerJoin(
          permissionsTable,
          eq(rolePermissionsTable.permissionId, permissionsTable.id),
        )
        .where(eq(rolePermissionsTable.roleId, role.id))
        .orderBy(desc(permissionsTable.key));

      return {
        roleKey: role.key,
        roleName: role.name,
        permissions: assignments.map((assignment) => assignment.permissionKey),
      };
    });
  }

  async grantPermissionToRole(roleKey: string, permissionKey: string) {
    const normalizedRoleKey = roleKey.trim();
    const normalizedPermissionKey = permissionKey.trim();

    if (!normalizedRoleKey) {
      throw new BadRequestException('roleKey is required');
    }

    if (!normalizedPermissionKey) {
      throw new BadRequestException('permissionKey is required');
    }

    const db = this.database.connection;

    const [role] = await db
      .select({
        id: rolesTable.id,
        key: rolesTable.key,
        name: rolesTable.name,
      })
      .from(rolesTable)
      .where(eq(rolesTable.key, normalizedRoleKey))
      .limit(1);

    if (!role) {
      throw new NotFoundException(
        `Role with key '${normalizedRoleKey}' not found`,
      );
    }

    const [permission] = await db
      .select({
        id: permissionsTable.id,
        key: permissionsTable.key,
      })
      .from(permissionsTable)
      .where(eq(permissionsTable.key, normalizedPermissionKey))
      .limit(1);

    if (!permission) {
      throw new NotFoundException(
        `Permission with key '${normalizedPermissionKey}' not found`,
      );
    }

    await db
      .insert(rolePermissionsTable)
      .values({
        roleId: role.id,
        permissionId: permission.id,
      })
      .onConflictDoNothing();

    const assignments = await db
      .select({
        permissionKey: permissionsTable.key,
      })
      .from(rolePermissionsTable)
      .innerJoin(
        permissionsTable,
        eq(rolePermissionsTable.permissionId, permissionsTable.id),
      )
      .where(eq(rolePermissionsTable.roleId, role.id))
      .orderBy(asc(permissionsTable.key));

    return {
      roleKey: role.key,
      roleName: role.name,
      permissions: assignments.map((assignment) => assignment.permissionKey),
    };
  }

  async assignRolesToUser(userId: number, roleKeys: string[]) {
    const db = this.database.connection;
    const uniqueKeys = [...new Set(roleKeys.map((key) => key.trim()))].filter(
      (key) => key.length > 0,
    );

    if (uniqueKeys.length === 0) {
      throw new BadRequestException('roleKeys must contain at least one value');
    }

    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user) {
      throw new NotFoundException(`User with id '${userId}' not found`);
    }

    const roles =
      uniqueKeys.length === 0
        ? []
        : await db
            .select({
              id: rolesTable.id,
              key: rolesTable.key,
            })
            .from(rolesTable)
            .where(inArray(rolesTable.key, uniqueKeys));

    const missingRoles = uniqueKeys.filter(
      (roleKey) => !roles.some((role) => role.key === roleKey),
    );
    if (missingRoles.length > 0) {
      throw new NotFoundException(
        `Roles not found: ${missingRoles.join(', ')}`,
      );
    }

    if (roles.length > 0) {
      await db
        .insert(userRolesTable)
        .values(
          roles.map((role) => ({
            userId,
            roleId: role.id,
          })),
        )
        .onConflictDoNothing();
    }

    return this.getUserRoleSummary(userId);
  }

  private async getUserRoleSummary(userId: number) {
    const db = this.database.connection;

    const assignments = await db
      .select({
        roleKey: rolesTable.key,
        permissionKey: permissionsTable.key,
      })
      .from(userRolesTable)
      .innerJoin(rolesTable, eq(userRolesTable.roleId, rolesTable.id))
      .leftJoin(
        rolePermissionsTable,
        eq(rolePermissionsTable.roleId, rolesTable.id),
      )
      .leftJoin(
        permissionsTable,
        eq(rolePermissionsTable.permissionId, permissionsTable.id),
      )
      .where(eq(userRolesTable.userId, userId))
      .orderBy(asc(rolesTable.key), asc(permissionsTable.key));

    const roleKeys = [
      ...new Set(assignments.map((assignment) => assignment.roleKey)),
    ];
    const permissionKeys = [
      ...new Set(
        assignments
          .map((assignment) => assignment.permissionKey)
          .filter((key): key is string => Boolean(key)),
      ),
    ];

    return {
      userId,
      roles: roleKeys,
      permissions: permissionKeys,
    };
  }
}
