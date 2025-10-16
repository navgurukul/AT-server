import { Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, or } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import { auditLogs, usersTable } from '../../db/schema';

interface AuditFilters {
  subjectType?: string;
  actorId?: number;
  search?: string;
  limit?: number;
}

@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  async listLogs(params: AuditFilters = {}) {
    const db = this.database.connection;

    const filters = [];
    if (params.subjectType) {
      filters.push(eq(auditLogs.subjectType, params.subjectType));
    }
    if (params.actorId) {
      filters.push(eq(auditLogs.actorUserId, params.actorId));
    }
    if (params.search) {
      const term = `%${params.search.toLowerCase()}%`;
      filters.push(
        or(
          ilike(auditLogs.action, term),
          ilike(auditLogs.subjectType, term),
        ),
      );
    }

    const whereClause =
      filters.length > 0
        ? and(...(filters as [typeof filters[number], ...typeof filters]))
        : undefined;

    const limit = params.limit && params.limit > 0 ? params.limit : 100;

    const logs = await db
      .select({
        id: auditLogs.id,
        orgId: auditLogs.orgId,
        actorUserId: auditLogs.actorUserId,
        actorRole: auditLogs.actorRole,
        action: auditLogs.action,
        subjectType: auditLogs.subjectType,
        subjectId: auditLogs.subjectId,
        prev: auditLogs.prev,
        next: auditLogs.next,
        meta: auditLogs.meta,
        at: auditLogs.at,
        actor: {
          id: usersTable.id,
          name: usersTable.name,
          email: usersTable.email,
        },
      })
      .from(auditLogs)
      .leftJoin(usersTable, eq(auditLogs.actorUserId, usersTable.id))
      .where(whereClause)
      .orderBy(desc(auditLogs.at), desc(auditLogs.id))
      .limit(limit);

    return logs;
  }
}
