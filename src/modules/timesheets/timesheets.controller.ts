import {
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { CreateTimesheetDto } from './dto/create-timesheet.dto';
import { TimesheetsService } from './timesheets.service';

@ApiTags('timesheets')
@Controller('timesheets')
export class TimesheetsController {
  constructor(private readonly timesheetsService: TimesheetsService) {}

  @Get()
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'state', required: false })
  @Permissions('timesheet:view')
  listTimesheets(
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('state') state?: string,
  ) {
    return this.timesheetsService.listTimesheets({
      userId: userId ? Number.parseInt(userId, 10) : undefined,
      from: from ?? undefined,
      to: to ?? undefined,
      state: state ?? undefined,
    });
  }

  @Post()
  @Permissions('timesheet:edit:self')
  createOrUpsert(
    @Body() payload: CreateTimesheetDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    if (!user) {
      return null;
    }
    return this.timesheetsService.createOrUpsert(payload, user.id, user.orgId);
  }
}
