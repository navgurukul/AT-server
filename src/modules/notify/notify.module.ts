import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { DatabaseModule } from "../../database/database.module";
import { NotifyController } from "./notify.controller";
import { NotifyService } from "./notify.service";

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [NotifyController],
  providers: [NotifyService],
  exports: [NotifyService],
})
export class NotifyModule {}
