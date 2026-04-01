import { Injectable } from "@nestjs/common";
import { and, eq, gte, lte } from "drizzle-orm";

import { DatabaseService } from "../../database/database.service";
import { orgHolidaysTable } from "../../db/schema";

@Injectable()
export class CalendarService {
  constructor(private readonly database: DatabaseService) {}

  private formatDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private normalize(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    );
  }

  async isHoliday(orgId: number, date: Date): Promise<boolean> {
    const db = this.database.connection;
    const normalized = this.normalize(date);
    const key = this.formatDateKey(normalized);

    const [holiday] = await db
      .select({
        isWorkingDay: orgHolidaysTable.isWorkingDay,
      })
      .from(orgHolidaysTable)
      .where(
        and(eq(orgHolidaysTable.orgId, orgId), eq(orgHolidaysTable.date, key))
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
        name: orgHolidaysTable.name,
      })
      .from(orgHolidaysTable)
      .where(
        and(
          eq(orgHolidaysTable.orgId, orgId),
          gte(orgHolidaysTable.date, startKey),
          lte(orgHolidaysTable.date, endKey)
        )
      );

    const map = new Map<string, { isWorkingDay: boolean; name: string | null }>();
    for (const row of rows) {
      const date = new Date(row.date as unknown as string | Date);
      const key = this.formatDateKey(date);
      map.set(key, { isWorkingDay: !!row.isWorkingDay, name: row.name ?? null });
    }

    return map;
  }

  async getWorkingDaysMap(orgId: number, start: Date, end: Date) {
    const map = new Map<string, boolean>();
    const cursor = new Date(start);
    const holidayMap = await this.getHolidayMap(orgId, start, end);

    while (cursor <= end) {
      const dayOfWeek = cursor.getUTCDay();
      const isSunday = dayOfWeek === 0;
      const isSaturday = dayOfWeek === 6;
      const isSecondFourthSaturday =
        isSaturday && this.isSecondOrFourthSaturday(cursor);
      const defaultWorking = !(isSunday || isSecondFourthSaturday);

      const key = this.formatDateKey(cursor);
      const holidayOverride = holidayMap.get(key);

      const isWorkingDay =
        holidayOverride !== undefined
          ? holidayOverride.isWorkingDay
          : defaultWorking;

      if (isWorkingDay) {
        map.set(key, true);
      }

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return map;
  }

  private isSecondOrFourthSaturday(date: Date): boolean {
    const occurrence = Math.ceil(date.getUTCDate() / 7);
    return occurrence === 2 || occurrence === 4;
  }

  async getDayInfo(orgId: number, date: Date): Promise<{
    isWorkingDay: boolean;
    isWeekend: boolean;
    isHoliday: boolean;
  }> {
    const normalized = this.normalize(date);
    const dayOfWeek = normalized.getUTCDay();
    const isSunday = dayOfWeek === 0;
    const isSaturday = dayOfWeek === 6;
    const isWeekend = isSunday || isSaturday;
    const isSecondFourthSaturday =
      isSaturday && this.isSecondOrFourthSaturday(normalized);
    const defaultWorking = !(isSunday || isSecondFourthSaturday);

    const map = await this.getHolidayMap(orgId, normalized, normalized);
    const override = map.get(this.formatDateKey(normalized));
    const isWorkingDay =
      override !== undefined ? override.isWorkingDay : defaultWorking;
    const isHoliday = override ? !override.isWorkingDay : false;

    return {
      isWorkingDay,
      isWeekend,
      isHoliday,
    };
  }

  async getWorkingDayInfo(orgId: number, from: Date, to: Date) {
    const workingDays = await this.getWorkingDaysMap(orgId, from, to);
    const holidays = await this.getHolidayMap(orgId, from, to);

    const info = new Map<string, { isWorkingDay: boolean; isHoliday: boolean }>();
    const cursor = new Date(from);

    while (cursor <= to) {
      const key = this.formatDateKey(cursor);
      const isHoliday = holidays.has(key);
      const isWorking = workingDays.has(key) && !isHoliday;

      info.set(key, { isWorkingDay: isWorking, isHoliday });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return info;
  }

  async getWorkingDaysBetween(startDate: Date, endDate: Date): Promise<number> {
    const db = this.database.connection;
    const orgId = 1; // Assuming a default orgId as it's not available here.
    const workingDays = await this.getWorkingDaysMap(orgId, startDate, endDate);
    const holidays = await this.getHolidayMap(orgId, startDate, endDate);

    let count = 0;
    const cursor = new Date(startDate);

    while (cursor < endDate) {
      const day = cursor.getUTCDay();
      const key = `${cursor.getUTCFullYear()}-${(cursor.getUTCMonth() + 1)
        .toString()
        .padStart(2, '0')}-${cursor.getUTCDate().toString().padStart(2, '0')}`;

      const isHoliday = holidays.has(key);
      const isWorkingDay = workingDays.has(key);

      if (isWorkingDay && !isHoliday) {
        count++;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return count;
  }

  private formatDate(date: Date): string {
    return `${date.getUTCFullYear()}-${(date.getUTCMonth() + 1)
      .toString()
      .padStart(2, '0')}-${date.getUTCDate().toString().padStart(2, '0')}`;
  }
}
