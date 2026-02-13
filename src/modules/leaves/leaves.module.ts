import { Module, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from "@nestjs/core";

import { CalendarModule } from '../calendar/calendar.module';
import { LeavesController } from './leaves.controller';
import { LeavesService } from './leaves.service';

@Module({
  imports: [CalendarModule],
  controllers: [LeavesController],
  providers: [LeavesService],
  exports: [LeavesService],
})
export class LeavesModule implements OnModuleInit {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly leavesService: LeavesService,
  ) {}

  async onModuleInit() {
    // Set LeavesService in NotifyService to avoid circular dependency
    try {
      const notifyService = await this.moduleRef.get('NotifyService', { strict: false });
      if (notifyService && typeof notifyService.setLeavesService === 'function') {
        notifyService.setLeavesService(this.leavesService);
      }
    } catch (error) {
      // NotifyService might not be available in testing/dev environments
    }
  }
}
