import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import { GoogleSheetService } from './google-sheet.service';
import {
  timesheetEntriesTable,
  timesheetsTable,
  usersTable,
  projectsTable,
  departmentsTable,
} from '../../db/schema';

@Injectable()
export class TimesheetSyncService {
  private readonly logger = new Logger(TimesheetSyncService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly googleSheetService: GoogleSheetService,
  ) {}

  async syncTimesheetToGoogleSheet(userId: number, workDate: Date | string) {
    const db = this.database.connection;
    const normalizedWorkDate = workDate instanceof Date ? workDate : new Date(workDate);
    
    // Normalize date to UTC midnight just like the rest of the application
    const targetWorkDate = new Date(
      Date.UTC(
        normalizedWorkDate.getUTCFullYear(),
        normalizedWorkDate.getUTCMonth(),
        normalizedWorkDate.getUTCDate(),
      ),
    );
    const dateStr = targetWorkDate.toISOString().split('T')[0];

    try {
      // 1. Fetch user email
      const [user] = await db
        .select({ email: usersTable.email })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);

      if (!user) {
        this.logger.warn(`User with ID ${userId} not found, skipping sync.`);
        return;
      }
      const targetEmail = user.email.trim().toLowerCase();

      // 2. Fetch active db rows for user + workDate
      const entries = await db
        .select({
          email: usersTable.email,
          workDate: timesheetsTable.workDate,
          departmentName: departmentsTable.name,
          projectName: projectsTable.name,
          hoursDecimal: timesheetEntriesTable.hoursDecimal,
          taskDescription: timesheetEntriesTable.taskDescription,
          taskTitle: timesheetEntriesTable.taskTitle,
          createdAt: timesheetEntriesTable.createdAt,
          projectId: timesheetEntriesTable.projectId,
        })
        .from(timesheetEntriesTable)
        .innerJoin(timesheetsTable, eq(timesheetEntriesTable.timesheetId, timesheetsTable.id))
        .innerJoin(usersTable, eq(timesheetsTable.userId, usersTable.id))
        .leftJoin(projectsTable, eq(timesheetEntriesTable.projectId, projectsTable.id))
        .leftJoin(departmentsTable, eq(projectsTable.departmentId, departmentsTable.id))
        .where(
          and(
            eq(timesheetsTable.userId, userId),
            eq(timesheetsTable.workDate, targetWorkDate),
            eq(timesheetEntriesTable.status, 'approved'),
          ),
        );

      // 3. Aggregate rows
      // Grouping rules: user_id, email, work_date, project_id
      interface AggregatedRow {
        email: string;
        workDate: string;
        department: string;
        projectName: string;
        hours: number;
        descriptions: string[];
        createdAt: Date;
      }

      const groups = new Map<string, AggregatedRow>();

      for (const entry of entries) {
        const projectId = entry.projectId ?? 0;
        const key = `${userId}::${targetEmail}::${dateStr}::${projectId}`;
        
        const hoursVal = Number(entry.hoursDecimal || 0);
        const desc = (entry.taskDescription || entry.taskTitle || '').trim();
        const createdAtDate = entry.createdAt ? new Date(entry.createdAt) : new Date();

        const existing = groups.get(key);
        if (existing) {
          existing.hours += hoursVal;
          if (desc) {
            existing.descriptions.push(desc);
          }
          if (createdAtDate < existing.createdAt) {
            existing.createdAt = createdAtDate;
          }
        } else {
          groups.set(key, {
            email: targetEmail,
            workDate: dateStr,
            department: entry.departmentName ?? '',
            projectName: entry.projectName ?? '',
            hours: hoursVal,
            descriptions: desc ? [desc] : [],
            createdAt: createdAtDate,
          });
        }
      }

      // Convert grouped values to final rows
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const dayOfWeek = days[targetWorkDate.getUTCDay()];

      const dbAggregatedRows = Array.from(groups.values()).map((g) => {
        const uniqueDescs = Array.from(new Set(g.descriptions.filter(Boolean)));
        const combinedDescription = uniqueDescs.join(' | ');
        const formattedCreatedAt = this.formatPostgresTimestamp(g.createdAt);

        return {
          email: g.email.trim().toLowerCase(),
          work_date: g.workDate,
          department: g.department,
          project_name: g.projectName,
          hours: g.hours.toFixed(2),
          description: combinedDescription,
          day_of_week: dayOfWeek,
          created_at: formattedCreatedAt,
        };
      });

      // 4. Read existing Google Sheet rows
      const sheetRows = await this.googleSheetService.readRows();

      // Ensure headers if completely empty
      if (sheetRows.length === 0) {
        const headers = [
          'email',
          'work_date',
          'department',
          'project_name',
          'hours',
          'description',
          'day_of_week',
          'created_at',
        ];
        await this.googleSheetService.appendRow(headers);
        sheetRows.push(headers);
      }

      // 5. Match and Compare rows
      const normalize = (val: any) => (val ?? '').toString().trim().toLowerCase();
      
      const targetUserDateRowsInSheet: { index: number; row: any[] }[] = [];
      for (let i = 1; i < sheetRows.length; i++) {
        const row = sheetRows[i];
        const rowEmail = normalize(row[0]);
        const rowWorkDateStr = (row[1] ?? '').toString().trim().split(' ')[0];
        const rowWorkDateNormalized = normalize(rowWorkDateStr);

        if (rowEmail === targetEmail && rowWorkDateNormalized === dateStr) {
          targetUserDateRowsInSheet.push({ index: i, row });
        }
      }

      const rowsToDelete: number[] = [];
      const matchedDbRowKeys = new Set<string>();

      let rowsInsertedCount = 0;
      let rowsUpdatedCount = 0;
      let rowsDeletedCount = 0;

      for (const sheetRowInfo of targetUserDateRowsInSheet) {
        const sheetProjectName = normalize(sheetRowInfo.row[3]);
        
        const match = dbAggregatedRows.find(
          (r) => normalize(r.project_name) === sheetProjectName,
        );

        if (match) {
          const sheetHoursStr = Number(sheetRowInfo.row[4] || 0).toFixed(2);
          const dbHoursStr = Number(match.hours).toFixed(2);
          
          const hasChange =
            normalize(sheetRowInfo.row[2]) !== normalize(match.department) ||
            sheetHoursStr !== dbHoursStr ||
            normalize(sheetRowInfo.row[5]) !== normalize(match.description) ||
            normalize(sheetRowInfo.row[6]) !== normalize(match.day_of_week) ||
            normalize(sheetRowInfo.row[7]) !== normalize(match.created_at);

          if (hasChange) {
            const values = [
              match.email,
              match.work_date,
              match.department,
              match.project_name,
              match.hours,
              match.description,
              match.day_of_week,
              match.created_at,
            ];
            await this.googleSheetService.updateRow(sheetRowInfo.index, values);
            rowsUpdatedCount++;
          }
          matchedDbRowKeys.add(sheetProjectName);
        } else {
          rowsToDelete.push(sheetRowInfo.index);
        }
      }

      // Appends for missing rows
      for (const dbRow of dbAggregatedRows) {
        const dbProjectKey = normalize(dbRow.project_name);
        if (!matchedDbRowKeys.has(dbProjectKey)) {
          const values = [
            dbRow.email,
            dbRow.work_date,
            dbRow.department,
            dbRow.project_name,
            dbRow.hours,
            dbRow.description,
            dbRow.day_of_week,
            dbRow.created_at,
          ];
          await this.googleSheetService.appendRow(values);
          rowsInsertedCount++;
        }
      }

      // Process deletions in reverse order to preserve indices
      rowsToDelete.sort((a, b) => b - a);
      for (const index of rowsToDelete) {
        await this.googleSheetService.deleteRow(index);
        rowsDeletedCount++;
      }

      if (rowsInsertedCount > 0 || rowsUpdatedCount > 0 || rowsDeletedCount > 0) {
        this.logger.log(
          `Google Sheet synced successfully for user=${targetEmail} on date=${dateStr}: ` +
            `inserted=${rowsInsertedCount}, updated=${rowsUpdatedCount}, deleted=${rowsDeletedCount}`,
        );
      } else {
        this.logger.log(`Google Sheet synced: No changes needed for user=${targetEmail} on date=${dateStr}`);
      }

    } catch (error: any) {
      this.logger.warn(
        `Google sync failed for user ${userId} on date ${dateStr}: ${error.message}`,
      );
      throw error;
    }
  }

  private formatPostgresTimestamp(date: Date): string {
    const pad = (num: number) => String(num).padStart(2, '0');
    const yyyy = date.getUTCFullYear();
    const mm = pad(date.getUTCMonth() + 1);
    const dd = pad(date.getUTCDate());
    const hh = pad(date.getUTCHours());
    const min = pad(date.getUTCMinutes());
    const ss = pad(date.getUTCSeconds());
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}+00`;
  }

  @Cron('0 2 * * *', {
    name: 'timesheets-google-sheet-recovery',
    timeZone: 'Asia/Kolkata',
  })
  async runDailyRecoveryCron() {
    this.logger.log('Starting Timesheet Google Sheets Daily Recovery Cron...');
    const db = this.database.connection;

    try {
      const query = sql`
        SELECT DISTINCT t.user_id as "userId", t.work_date as "workDate"
        FROM public.timesheet_entries te
        JOIN public.timesheets t ON te.timesheet_id = t.id
        WHERE COALESCE(te.updated_at, te.created_at) >= NOW() - INTERVAL '1 day'
      `;
      
      const result = await db.execute<{ userId: number; workDate: Date | string }>(query);
      const rows = result.rows ?? [];

      this.logger.log(`Found ${rows.length} affected user/date combination(s) in the last 24 hours.`);

      for (const row of rows) {
        const userId = Number((row as any).userId ?? (row as any).user_id);
        const workDate = (row as any).workDate ?? (row as any).work_date;
        try {
          await this.syncTimesheetToGoogleSheet(userId, workDate);
        } catch (syncError) {
          this.logger.error(
            `Recovery Cron failed to sync user ID ${userId} on date ${workDate}:`,
            syncError,
          );
        }
      }
      this.logger.log('Timesheet Google Sheets Daily Recovery Cron completed.');
    } catch (error) {
      this.logger.error('Error running daily recovery cron:', error);
    }
  }
}
