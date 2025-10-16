import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  sql,
} from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import {
  costRatesTable,
  orgs,
  payrollWindowsTable,
  timesheetEntriesTable,
  timesheetsTable,
  usersTable,
} from '../../db/schema';

export interface PayrollSummaryRow {
  userId: number;
  userName: string | null;
  userEmail: string | null;
  totalHours: number;
  totalCostMinor: number;
}

@Injectable()
export class PayrollService {
  constructor(private readonly database: DatabaseService) {}

  async freezeWindow(month: number, year: number) {
    this.assertValidMonth(month);
    this.assertValidYear(year);

    const db = this.database.connection;
    const orgId = await this.resolvePrimaryOrgId();
    const now = new Date();
    const windowStart = new Date(Date.UTC(year, month - 1, 1));
    const windowEnd = new Date(Date.UTC(year, month, 1));

    return db.transaction(async (tx) => {
      const [window] = await tx
        .insert(payrollWindowsTable)
        .values({
          orgId,
          month,
          year,
          freezeState: 'frozen',
          frozenAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            payrollWindowsTable.orgId,
            payrollWindowsTable.year,
            payrollWindowsTable.month,
          ],
          set: {
            freezeState: 'frozen',
            frozenAt: now,
            updatedAt: now,
          },
        })
        .returning({
          id: payrollWindowsTable.id,
          orgId: payrollWindowsTable.orgId,
          month: payrollWindowsTable.month,
          year: payrollWindowsTable.year,
          freezeState: payrollWindowsTable.freezeState,
          frozenAt: payrollWindowsTable.frozenAt,
          updatedAt: payrollWindowsTable.updatedAt,
        });

      const lockedTimesheets = await tx
        .update(timesheetsTable)
        .set({
          state: 'locked',
          lockedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(timesheetsTable.orgId, orgId),
            gte(timesheetsTable.workDate, windowStart),
            lt(timesheetsTable.workDate, windowEnd),
            inArray(timesheetsTable.state, ['approved', 'submitted'] as const),
          ),
        )
        .returning({ id: timesheetsTable.id });

      const [{ value: totalLocked }] = await tx
        .select({
          value: count(timesheetsTable.id),
        })
        .from(timesheetsTable)
        .where(
          and(
            eq(timesheetsTable.orgId, orgId),
            gte(timesheetsTable.workDate, windowStart),
            lt(timesheetsTable.workDate, windowEnd),
            eq(timesheetsTable.state, 'locked'),
          ),
        );

      return {
        window: {
          id: window.id,
          orgId: window.orgId,
          month: window.month,
          year: window.year,
          freezeState: window.freezeState,
          frozenAt: window.frozenAt,
          updatedAt: window.updatedAt,
        },
        lockedTimesheets: lockedTimesheets.length,
        totalLocked: Number(totalLocked ?? 0),
      };
    });
  }

  async exportPayroll(month: number, year: number) {
    this.assertValidMonth(month);
    this.assertValidYear(year);

    const db = this.database.connection;
    const orgId = await this.resolvePrimaryOrgId();
    const windowStart = new Date(Date.UTC(year, month - 1, 1));
    const windowEnd = new Date(Date.UTC(year, month, 1));

    const timesheetSummary = await db.execute(
      sql`
        SELECT
          t.user_id AS user_id,
          u.name AS user_name,
          u.email AS user_email,
          COALESCE(SUM(te.hours_decimal), 0)::numeric AS total_hours
        FROM ${timesheetsTable} t
        INNER JOIN ${usersTable} u ON u.id = t.user_id
        LEFT JOIN ${timesheetEntriesTable} te ON te.timesheet_id = t.id
        WHERE t.org_id = ${orgId}
          AND t.work_date >= ${windowStart}
          AND t.work_date < ${windowEnd}
          AND t.state IN ('approved','locked')
        GROUP BY t.user_id, u.name, u.email
        ORDER BY u.name ASC
      `,
    );

    const costSummary = await db.execute(
      sql`
        SELECT
          t.user_id AS user_id,
          SUM(te.hours_decimal * COALESCE(rate.hourly_cost_minor_currency, 0))::numeric AS total_cost_minor
        FROM ${timesheetsTable} t
        INNER JOIN ${timesheetEntriesTable} te ON te.timesheet_id = t.id
        LEFT JOIN LATERAL (
          SELECT hourly_cost_minor_currency
          FROM ${costRatesTable} cr
          WHERE cr.user_id = t.user_id
            AND cr.effective_from <= t.work_date
            AND (cr.effective_to IS NULL OR cr.effective_to >= t.work_date)
          ORDER BY cr.effective_from DESC
          LIMIT 1
        ) rate ON TRUE
        WHERE t.org_id = ${orgId}
          AND t.work_date >= ${windowStart}
          AND t.work_date < ${windowEnd}
          AND t.state IN ('approved','locked')
        GROUP BY t.user_id
      `,
    );

    const costByUser = new Map<number, number>();
    for (const row of costSummary.rows as { user_id: number; total_cost_minor: string | null }[]) {
      costByUser.set(
        Number(row.user_id),
        row.total_cost_minor ? Number(row.total_cost_minor) : 0,
      );
    }

    const rows: PayrollSummaryRow[] = (timesheetSummary.rows as {
      user_id: number;
      user_name: string | null;
      user_email: string | null;
      total_hours: string | null;
    }[]).map((row) => ({
      userId: Number(row.user_id),
      userName: row.user_name,
      userEmail: row.user_email,
      totalHours: row.total_hours ? Number(row.total_hours) : 0,
      totalCostMinor: costByUser.get(Number(row.user_id)) ?? 0,
    }));

    const totals = rows.reduce(
      (acc, row) => {
        acc.totalHours += row.totalHours;
        acc.totalCostMinor += row.totalCostMinor;
        return acc;
      },
      { totalHours: 0, totalCostMinor: 0 },
    );

    return {
      window: {
        orgId,
        month,
        year,
        from: windowStart,
        to: new Date(windowEnd.getTime() - 1),
      },
      totals: {
        people: rows.length,
        totalHours: Number(totals.totalHours.toFixed(2)),
        totalCostMinor: Math.round(totals.totalCostMinor),
      },
      rows,
    };
  }

  private async resolvePrimaryOrgId(): Promise<number> {
    const db = this.database.connection;
    const [org] = await db
      .select({
        id: orgs.id,
      })
      .from(orgs)
      .orderBy(desc(orgs.id))
      .limit(1);

    if (!org) {
      throw new NotFoundException('No organisation configured');
    }

    return Number(org.id);
  }

  private assertValidMonth(month: number) {
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      throw new BadRequestException('Month must be within 1-12');
    }
  }

  private assertValidYear(year: number) {
    if (!Number.isFinite(year) || year < 2000 || year > 9999) {
      throw new BadRequestException('Year must be valid four digit number');
    }
  }
}
