import { Controller, Get, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('logs')
  @ApiQuery({ name: 'subjectType', required: false })
  @ApiQuery({ name: 'actorId', required: false })
  @Permissions('audit:view')
  listLogs(
    @Query('subjectType') subjectType?: string,
    @Query('actorId') actorId?: string,
  ) {
    return this.auditService.listLogs({
      subjectType: subjectType ?? undefined,
      actorId: actorId ? Number.parseInt(actorId, 10) : undefined,
    });
  }
}
