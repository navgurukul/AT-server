import { Module } from '@nestjs/common';
import { TimesheetsModule } from '../timesheets/timesheets.module';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TimesheetsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
