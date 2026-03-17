import { Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import { auditLogs, usersTable } from '../../db/schema';

interface AuditFilters {
  role?: 'admin' | 'super_admin';
  actorId?: number;
  targetUserId?: number;
}

interface CreateAuditLogParams {
  orgId: number;
  actorUserId?: number | null;
  actorRole?: string | null;
  action: string;
  subjectType: string;
  targetUserId?: number | null;
  prev?: unknown;
  next?: unknown;
  tx?: any;
}

@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  async createLog(params: CreateAuditLogParams) {
    const db = params.tx ?? this.database.connection;

    const [created] = await db
      .insert(auditLogs)
      .values({
        orgId: params.orgId,
        actorUserId: params.actorUserId ?? null,
        actorRole: params.actorRole ?? null,
        action: params.action,
        subjectType: params.subjectType,
        targetUserId: params.targetUserId ?? null,
        prev: params.prev ?? null,
        next: params.next ?? null,
      })
      .returning({ id: auditLogs.id });

    return created;
  }

  async listLogs(params: AuditFilters = {}) {
    const db = this.database.connection;

    const privilegedRoles: Array<'admin' | 'super_admin'> = [
      'admin',
      'super_admin',
    ];

    const filters = [
      params.role
        ? eq(auditLogs.actorRole, params.role)
        : inArray(auditLogs.actorRole, privilegedRoles),
    ];

    if (params.actorId) {
      filters.push(eq(auditLogs.actorUserId, params.actorId));
    }
    if (params.targetUserId) {
      filters.push(eq(auditLogs.targetUserId, params.targetUserId));
    }

    const whereClause = and(...filters);
    const limit = 100;

    const logs = await db
      .select({
        id: auditLogs.id,
        orgId: auditLogs.orgId,
        actorUserId: auditLogs.actorUserId,
        actorRole: auditLogs.actorRole,
        action: auditLogs.action,
        subjectType: auditLogs.subjectType,
        targetUserId: auditLogs.targetUserId,
        prev: auditLogs.prev,
        next: auditLogs.next,
        createdAt: auditLogs.createdAt,
        actor: {
          id: usersTable.id,
          name: usersTable.name,
          email: usersTable.email,
        },
      })
      .from(auditLogs)
      .leftJoin(usersTable, eq(auditLogs.actorUserId, usersTable.id))
      .where(whereClause)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit);

    return logs;
  }
}
