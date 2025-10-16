import { Controller, Get, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { ApprovalsService } from './approvals.service';

@ApiTags('approvals')
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Get()
  @ApiQuery({ name: 'subjectType', required: false })
  @ApiQuery({ name: 'state', required: false })
  @Permissions('approvals:view')
  listApprovals(
    @Query('subjectType') subjectType?: string,
    @Query('state') state?: string,
  ) {
    return this.approvalsService.listApprovals({
      subjectType: subjectType ?? undefined,
      state: state ?? undefined,
    });
  }
}
