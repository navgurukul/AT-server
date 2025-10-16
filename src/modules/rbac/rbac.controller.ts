import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';
import { RbacService } from './rbac.service';

@ApiTags('rbac')
@Controller('rbac')
export class RbacController {
  constructor(private readonly rbacService: RbacService) {}

  @Get('roles')
  @Permissions('rbac:view')
  listRoles() {
    return this.rbacService.listRoles();
  }

  @Get('permissions')
  @Permissions('rbac:view')
  listPermissions() {
    return this.rbacService.listPermissions();
  }

  @Post('roles/:roleKey/permissions')
  @Permissions('rbac:assign')
  assignPermissions(
    @Param('roleKey') roleKey: string,
    @Body() payload: AssignPermissionsDto,
  ) {
    return this.rbacService.assignPermissionsToRole(roleKey, payload.permissionKeys);
  }
}
