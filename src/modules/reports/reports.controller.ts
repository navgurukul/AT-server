import { Controller, Get, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('productivity/daily')
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'teamId', required: false })
  @ApiQuery({ name: 'userId', required: false })
  @Permissions('report:view:productivity')
  getDailyProductivity(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('teamId') teamId?: string,
    @Query('userId') userId?: string,
  ) {
    return this.reportsService.getDailyProductivity({
      from: from ?? undefined,
      to: to ?? undefined,
      teamId: teamId ? Number.parseInt(teamId, 10) : undefined,
      userId: userId ? Number.parseInt(userId, 10) : undefined,
    });
  }

  @Get('project-costs')
  @ApiQuery({ name: 'projectId', required: true })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @Permissions('report:view:project-costs')
  getProjectCosts(
    @Query('projectId') projectId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reportsService.getProjectCosts({
      projectId: Number.parseInt(projectId, 10),
      from: from ?? undefined,
      to: to ?? undefined,
    });
  }

  @Get('employee/monthly-summary')
  @ApiQuery({ name: 'userId', required: true })
  @ApiQuery({ name: 'year', required: true })
  @ApiQuery({ name: 'month', required: true })
  @Permissions('report:view:productivity')
  getEmployeeMonthlySummary(
    @Query('userId') userId: string,
    @Query('year') year: string,
    @Query('month') month: string,
  ) {
    return this.reportsService.getEmployeeMonthlySummary({
      userId: Number.parseInt(userId, 10),
      year: Number.parseInt(year, 10),
      month: Number.parseInt(month, 10),
    });
  }

  @Get('project/cost-breakdown')
  @ApiQuery({ name: 'projectId', required: true })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @Permissions('report:view:project-costs')
  getProjectCostBreakdown(
    @Query('projectId') projectId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reportsService.getProjectCostBreakdown({
      projectId: Number.parseInt(projectId, 10),
      from: from ?? undefined,
      to: to ?? undefined,
    });
  }
}
