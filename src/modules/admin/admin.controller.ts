import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { UpdateUserRoleDto } from '../users/dto/update-user-role.dto';
import { UsersService } from '../users/users.service';
import { AdminService } from './admin.service';

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly usersService: UsersService,
  ) {}

  @Get('status')
  @Permissions('admin:status')
  status() {
    return this.adminService.getStatus();
  }

  @Patch('users/:userId/role')
  @Permissions('users:manage')
  updateUserRole(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() payload: UpdateUserRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.usersService.updateUserRole(actor, userId, payload.role);
  }
}
