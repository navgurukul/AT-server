import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, desc, eq, inArray } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import {
  permissionsTable,
  rolePermissionsTable,
  rolesTable,
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
}
