import { Module, OnModuleInit } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ModuleRef } from "@nestjs/core";

import { DatabaseModule } from "../../database/database.module";
import { NotifyController } from "./notify.controller";
import { NotifyService } from "./notify.service";

@Module({
  imports: [ConfigModule, DatabaseModule, ScheduleModule.forRoot()],
  controllers: [NotifyController],
  providers: [NotifyService],
  exports: [NotifyService],
})
export class NotifyModule implements OnModuleInit {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly notifyService: NotifyService,
  ) {}

  async onModuleInit() {
    // Lazily get LeavesService to avoid circular dependency
    try {
      const leavesService = await this.moduleRef.get('LeavesService', { strict: false });
      if (leavesService) {
        this.notifyService.setLeavesService(leavesService);
      }
    } catch (error) {
      // LeavesService might not be available yet, will be set later
    }
  }
}
