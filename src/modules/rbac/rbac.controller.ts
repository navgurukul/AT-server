import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';
import { AssignRolesDto } from './dto/assign-roles.dto';
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

  @Post('roles/:roleKey/permissions/:permissionKey')
  @Permissions('rbac:assign')
  grantPermissionToRole(
    @Param('roleKey') roleKey: string,
    @Param('permissionKey') permissionKey: string,
  ) {
    return this.rbacService.grantPermissionToRole(roleKey, permissionKey);
  }

  @Post('users/:userId/roles')
  @Permissions('rbac:assign')
  assignRolesToUser(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() payload: AssignRolesDto,
    @CurrentUser() actor: AuthenticatedUser | undefined,
  ) {
    return this.rbacService.assignRolesToUser(userId, payload.roleKeys, actor);
  }
}
