import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { CostingService } from './costing.service';

@ApiTags('costing')
@Controller('costing')
@ApiBearerAuth()
export class CostingController {
  constructor(private readonly costingService: CostingService) {}

  @Get('projects/:id')
  @Permissions('report:view:project-costs')
  getProjectCost(
    @Param('id', ParseIntPipe) projectId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.costingService.getProjectCostSummary(projectId, { from, to });
  }
}
