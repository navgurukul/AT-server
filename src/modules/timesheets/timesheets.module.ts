import { Module } from '@nestjs/common';

import { CalendarModule } from '../calendar/calendar.module';
import { LeavesModule } from '../leaves/leaves.module';
import { TimesheetsController } from './timesheets.controller';
import { TimesheetsService } from './timesheets.service';

@Module({
  imports: [CalendarModule, LeavesModule],
  controllers: [TimesheetsController],
  providers: [TimesheetsService],
  exports: [TimesheetsService],
})
export class TimesheetsModule {}
