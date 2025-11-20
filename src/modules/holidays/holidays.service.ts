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

  private fixedHolidaysForYear(year: number) {
    const dates = [
      { month: 1, day: 26, name: "Republic Day" },
      { month: 8, day: 15, name: "Independence Day" },
      { month: 10, day: 2, name: "Gandhi Jayanti" },
      { month: 12, day: 31, name: "New Year's Eve" },
    ];

    return dates.map((h) => {
      const date = new Date(Date.UTC(year, h.month - 1, h.day));
      const iso = date.toISOString().slice(0, 10);
      const dayName = date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
      return {
        id: null,
        orgId: null,
        date: iso,
        name: h.name,
        day: dayName,
        isWorkingDay: false,
        createdAt: null,
        updatedAt: null,
      };
    });
  }

  async list(orgId: number | undefined, params: { from?: string; to?: string }) {
    const from = params.from ? new Date(params.from) : undefined;
    const to = params.to ? new Date(params.to) : undefined;

    if (!params.from && !params.to) {
      const year = new Date().getUTCFullYear();
      return this.fixedHolidaysForYear(year);
    }

    const startYear = from ? from.getUTCFullYear() : to ? to.getUTCFullYear() : new Date().getUTCFullYear();
    const endYear = to ? to.getUTCFullYear() : startYear;

    const holidays: ReturnType<HolidaysService["fixedHolidaysForYear"]> = [];
    for (let y = startYear; y <= endYear; y += 1) {
      holidays.push(...this.fixedHolidaysForYear(y));
    }

    const filtered = holidays.filter((h) => {
      const d = new Date(h.date);
      if (from && d < from) {
        return false;
      }
      if (to && d > to) {
        return false;
      }
      return true;
    });

    return filtered;
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

