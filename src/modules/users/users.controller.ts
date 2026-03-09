import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { SalaryCycleUtil } from '../../common/utils/salary-cycle.util';
import { TimesheetsService } from '../timesheets/timesheets.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly timesheetsService: TimesheetsService,
  ) {}

  @Get('search/employee')
  @ApiQuery({ name: 'email', required: true })
  @Permissions('users:view')
  async searchEmployeeByEmail(
    @Query('email') email: string,
    @CurrentUser() actor: AuthenticatedUser | undefined,
  ) {
    if (!actor) {
      return null;
    }

    // Check role-based access
    const isSuperAdmin = actor.roles.includes('super_admin');
    const isAdmin = actor.roles.includes('admin');
    const isManager = actor.roles.includes('manager');

    // Only SUPER_ADMIN, ADMIN, and REPORTING_MANAGER (manager) can access
    if (!isSuperAdmin && !isAdmin && !isManager) {
      throw new BadRequestException(
        'Access denied. Only SUPER_ADMIN, ADMIN, or REPORTING_MANAGER can search employees.',
      );
    }

    const currentCycle = SalaryCycleUtil.getCurrentSalaryCycle();

    const targetUser = await this.usersService.findUserByEmailInOrg({
      email,
      orgId: actor.orgId,
    });

    // REPORTING_MANAGER can only search their direct reports
    if (isManager && !isSuperAdmin && !isAdmin) {
      if (targetUser.managerId !== actor.id) {
        throw new BadRequestException(
          'Access denied. REPORTING_MANAGER can only search employees who directly report to them.',
        );
      }
    }

    return this.timesheetsService.getMonthlyDashboard({
      userId: targetUser.id,
      orgId: actor.orgId,
      year: currentCycle.year,
      month: currentCycle.month,
    });
  }

  @Get('managers')
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @Permissions('users:view')
  listManagers(
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.usersService.listReferencedManagers({
      query: q ?? undefined,
      page: page ? Number.parseInt(page, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  @Get()
  @ApiQuery({ name: 'managerId', required: false })
  @ApiQuery({ name: 'role', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @Permissions('users:view')
  listUsers(
    @Query('managerId') managerId?: string,
    @Query('role') role?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.usersService.searchUsers({
      managerId: managerId ? Number.parseInt(managerId, 10) : undefined,
      role: role ?? undefined,
      query: q ?? undefined,
      page: page ? Number.parseInt(page, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  @Patch(':id')
  @Permissions('users:manage')
  updateUser(
    @Param('id', ParseIntPipe) id: number,
    @Body() payload: UpdateUserDto,
    @CurrentUser() _actor: AuthenticatedUser,
  ) {
    return this.usersService.updateUser(id, payload);
  }

  @Post('sync/google-sheet')
  @Permissions('users:manage')
  syncFromGoogleSheet() {
    return this.usersService.syncUsersFromSheet();
  }

  @Post('sync/manager-roles')
  @Permissions('users:manage')
  syncManagerRoles() {
    return this.usersService.ensureReportingManagersHaveManagerRole();
  }
}
