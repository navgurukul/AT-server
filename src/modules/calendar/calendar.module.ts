import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { CalendarService } from './calendar.service';

@Module({
  imports: [DatabaseModule],
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
