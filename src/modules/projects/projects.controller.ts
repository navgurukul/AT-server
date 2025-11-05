import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { AssignMemberDto } from './dto/assign-member.dto';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @Permissions('project:create')
  createProject(@Body() payload: CreateProjectDto) {
    return this.projectsService.createProject(payload);
  }

  @Get()
  @Permissions('project:view')
  @ApiQuery({ name: 'orgId', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'departmentId', required: false, type: Number })
  @ApiQuery({ name: 'departmentName', required: false, type: String })
  @ApiQuery({ name: 'projectManagerId', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  listProjects(
    @Query('orgId') orgId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('departmentId') departmentId?: string,
    @Query('departmentName') departmentName?: string,
    @Query('projectManagerId') projectManagerId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.projectsService.listProjects({
      orgId: orgId ? Number.parseInt(orgId, 10) : undefined,
      status: status ?? undefined,
      search: search ?? undefined,
      departmentId: departmentId ? Number.parseInt(departmentId, 10) : undefined,
      departmentName: departmentName ?? undefined,
      projectManagerId: projectManagerId ? Number.parseInt(projectManagerId, 10) : undefined,
      page: page ? Number.parseInt(page, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  @Patch(':id')
  @Permissions('project:manage')
  updateProject(
    @Param('id', ParseIntPipe) id: number,
    @Body() payload: UpdateProjectDto,
  ) {
    return this.projectsService.updateProject(id, payload);
  }

  @Post(':id/members')
  @Permissions('project:assign')
  assignMember(
    @Param('id', ParseIntPipe) projectId: number,
    @Body() payload: AssignMemberDto,
  ) {
    return this.projectsService.assignMember(projectId, payload);
  }

  @Delete(':id/members/:userId')
  @Permissions('project:assign')
  removeMember(
    @Param('id', ParseIntPipe) projectId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.projectsService.removeMember(projectId, userId);
  }

  @Get(':id/costs')
  @Permissions('report:view:project-costs')
  getProjectCosts(
    @Param('id', ParseIntPipe) projectId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.projectsService.getProjectCosts(projectId, { from, to });
  }

  @Get(':id/contributors')
  @Permissions('report:view:project-costs')
  getProjectContributors(
    @Param('id', ParseIntPipe) projectId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.projectsService.getProjectContributors(projectId, {
      from,
      to,
    });
  }

  @Get(':id/hours')
  @Permissions('report:view:project-costs')
  getProjectUserHours(
    @Param('id', ParseIntPipe) projectId: number,
    @Query('userId', ParseIntPipe) userId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.projectsService.getProjectUserHours(projectId, userId, {
      from,
      to,
    });
  }
}
