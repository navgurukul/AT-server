import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { CalendarModule } from '../calendar/calendar.module';
import { LeavesModule } from '../leaves/leaves.module';
import { TimesheetsController } from './timesheets.controller';
import { TimesheetsService } from './timesheets.service';
import { GoogleSheetService } from './google-sheet.service';
import { TimesheetSyncService } from './timesheet-sync.service';

@Module({
  imports: [CalendarModule, LeavesModule, AuditModule],
  controllers: [TimesheetsController],
  providers: [TimesheetsService, GoogleSheetService, TimesheetSyncService],
  exports: [TimesheetsService, GoogleSheetService, TimesheetSyncService],
})
export class TimesheetsModule {}
