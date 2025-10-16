import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, lte } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import { orgHolidaysTable } from '../../db/schema';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';

function normalizeDateString(input: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.valueOf())) {
    throw new Error('Invalid date');
  }
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class HolidaysService {
  constructor(private readonly database: DatabaseService) {}

  async list(orgId: number, params: { from?: string; to?: string }) {
    const db = this.database.connection;

    const filters = [eq(orgHolidaysTable.orgId, orgId)];

    if (params.from) {
      filters.push(gte(orgHolidaysTable.date, normalizeDateString(params.from)));
    }
    if (params.to) {
      filters.push(lte(orgHolidaysTable.date, normalizeDateString(params.to)));
    }

    const whereClause = filters.length > 1 ? and(...filters) : filters[0];

    return db
      .select({
        id: orgHolidaysTable.id,
        orgId: orgHolidaysTable.orgId,
        date: orgHolidaysTable.date,
        name: orgHolidaysTable.name,
        isWorkingDay: orgHolidaysTable.isWorkingDay,
        createdAt: orgHolidaysTable.createdAt,
        updatedAt: orgHolidaysTable.updatedAt,
      })
      .from(orgHolidaysTable)
      .where(whereClause)
      .orderBy(orgHolidaysTable.date);
  }

  async create(payload: CreateHolidayDto) {
    const db = this.database.connection;
    const date = normalizeDateString(payload.date);

    const [created] = await db
      .insert(orgHolidaysTable)
      .values({
        orgId: payload.orgId,
        date,
        name: payload.name,
        isWorkingDay: payload.isWorkingDay ?? false,
      })
      .onConflictDoUpdate({
        target: [orgHolidaysTable.orgId, orgHolidaysTable.date],
        set: {
          name: payload.name,
          isWorkingDay: payload.isWorkingDay ?? false,
          updatedAt: new Date(),
        },
      })
      .returning();

    return created;
  }

  async update(id: number, payload: UpdateHolidayDto) {
    const db = this.database.connection;

    const [existing] = await db
      .select()
      .from(orgHolidaysTable)
      .where(eq(orgHolidaysTable.id, id))
      .limit(1);

    if (!existing) {
      throw new NotFoundException(`Holiday ${id} not found`);
    }

    const [updated] = await db
      .update(orgHolidaysTable)
      .set({
        name: payload.name ?? existing.name,
        isWorkingDay:
          payload.isWorkingDay === undefined
            ? existing.isWorkingDay
            : payload.isWorkingDay,
        updatedAt: new Date(),
      })
      .where(eq(orgHolidaysTable.id, id))
      .returning();

    return updated;
  }

  async delete(id: number) {
    const db = this.database.connection;

    const result = await db
      .delete(orgHolidaysTable)
      .where(eq(orgHolidaysTable.id, id))
      .returning({ id: orgHolidaysTable.id });

    if (result.length === 0) {
      throw new NotFoundException(`Holiday ${id} not found`);
    }

    return { id };
  }
}

