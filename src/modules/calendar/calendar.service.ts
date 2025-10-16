import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import { orgHolidaysTable } from '../../db/schema';

@Injectable()
export class CalendarService {
  constructor(private readonly database: DatabaseService) {}

  private formatDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  async isHoliday(orgId: number, date: Date): Promise<boolean> {
    const db = this.database.connection;
    const normalized = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const key = this.formatDateKey(normalized);

    const [holiday] = await db
      .select({
        isWorkingDay: orgHolidaysTable.isWorkingDay,
      })
      .from(orgHolidaysTable)
      .where(
        and(eq(orgHolidaysTable.orgId, orgId), eq(orgHolidaysTable.date, key)),
      )
      .limit(1);

    if (!holiday) {
      return false;
    }

    return !holiday.isWorkingDay;
  }

  async getHolidayMap(orgId: number, start: Date, end: Date) {
    const db = this.database.connection;
    const startKey = this.formatDateKey(start);
    const endKey = this.formatDateKey(end);

    const rows = await db
      .select({
        date: orgHolidaysTable.date,
        isWorkingDay: orgHolidaysTable.isWorkingDay,
      })
      .from(orgHolidaysTable)
      .where(
        and(
          eq(orgHolidaysTable.orgId, orgId),
          gte(orgHolidaysTable.date, startKey),
          lte(orgHolidaysTable.date, endKey),
        ),
      );

    const map = new Map<string, { isWorkingDay: boolean }>();
    for (const row of rows) {
      const date = new Date(row.date as unknown as string | Date);
      const key = this.formatDateKey(date);
      map.set(key, { isWorkingDay: !!row.isWorkingDay });
    }

    return map;
  }
}
