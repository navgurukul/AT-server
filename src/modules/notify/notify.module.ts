import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";

import { DatabaseModule } from "../../database/database.module";
import { NotifyController } from "./notify.controller";
import { NotifyService } from "./notify.service";

@Module({
  imports: [ConfigModule, DatabaseModule, ScheduleModule.forRoot()],
  controllers: [NotifyController],
  providers: [NotifyService],
  exports: [NotifyService],
})
export class NotifyModule {}
