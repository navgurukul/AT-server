import { Controller, Get, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('logs')
  @ApiQuery({ name: 'role', required: false, enum: ['admin', 'super_admin'] })
  @ApiQuery({ name: 'actorId', required: false })
  @ApiQuery({ name: 'targetUserId', required: false })
  @Permissions('audit:view')
  listLogs(
    @Query('role') role?: 'admin' | 'super_admin',
    @Query('actorId') actorId?: string,
    @Query('targetUserId') targetUserId?: string,
  ) {
    return this.auditService.listLogs({
      role,
      actorId: actorId ? Number.parseInt(actorId, 10) : undefined,
      targetUserId: targetUserId ? Number.parseInt(targetUserId, 10) : undefined,
    });
  }
}
