import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import { departmentsTable } from '../../db/schema';

@Injectable()
export class DepartmentsService {
  constructor(private readonly database: DatabaseService) {}

  async list(orgId?: number) {
    const db = this.database.connection;

    const query = db
      .select({
        id: departmentsTable.id,
        orgId: departmentsTable.orgId,
        name: departmentsTable.name,
        code: departmentsTable.code,
        description: departmentsTable.description,
        createdAt: departmentsTable.createdAt,
        updatedAt: departmentsTable.updatedAt,
      })
      .from(departmentsTable)
      .orderBy(asc(departmentsTable.name));

    const rows =
      orgId !== undefined ? await query.where(eq(departmentsTable.orgId, orgId)) : await query;

    return rows.map((row) => ({
      id: Number(row.id),
      orgId: Number(row.orgId),
      name: row.name,
      code: row.code ?? null,
      description: row.description ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }
}
