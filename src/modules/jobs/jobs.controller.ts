import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { JobsService } from './jobs.service';

class TriggerJobDto {
  @ApiProperty()
  @IsString()
  key!: string;
}

@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get()
  @Permissions('jobs:view')
  list() {
    return this.jobsService.listJobs();
  }

  @Post('trigger')
  @Permissions('jobs:trigger')
  trigger(@Body() payload: TriggerJobDto) {
    return this.jobsService.triggerJob(payload.key);
  }
}
