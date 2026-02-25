import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { CreateTimesheetDto } from './dto/create-timesheet.dto';
import { UpdateBackfillLimitDto } from './dto/update-backfill-limit.dto';
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

  @Get('monthly')
  @ApiQuery({ name: 'year', required: true })
  @ApiQuery({ name: 'month', required: true })
  @ApiQuery({ name: 'userId', required: false })
  getMonthlyDashboard(
    @Query('year') year: string,
    @Query('month') month: string,
    @Query('userId') userId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    if (!user) {
      return null;
    }

    const parsedYear = Number.parseInt(year, 10);
    const parsedMonth = Number.parseInt(month, 10);
    const parsedUserId = userId ? Number.parseInt(userId, 10) : user.id;

    const targetUserId = Number.isNaN(parsedUserId) ? user.id : parsedUserId;

    const canViewAll = user.permissions.includes('timesheet:view');
    const canViewSelf = user.permissions.includes('timesheet:view:self');

    if (targetUserId !== user.id && !canViewAll) {
      throw new ForbiddenException('Missing required permission: timesheet:view');
    }

    if (targetUserId === user.id && !(canViewAll || canViewSelf)) {
      throw new ForbiddenException('Missing required permission: timesheet:view');
    }

    return this.timesheetsService.getMonthlyDashboard({
      userId: targetUserId,
      orgId: user.orgId,
      year: parsedYear,
      month: parsedMonth,
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

  @Post('backfill/limit')
  @Permissions('users:manage')
  updateBackfillLimit(
    @Body() payload: UpdateBackfillLimitDto,
    @CurrentUser() actor: AuthenticatedUser | undefined,
  ) {
    if (!actor) {
      return null;
    }
    return this.timesheetsService.updateBackfillLimit({
      orgId: actor.orgId,
      userId: payload.userId,
      year: payload.year,
      month: payload.month,
      limit: payload.limit,
    });
  }
}
