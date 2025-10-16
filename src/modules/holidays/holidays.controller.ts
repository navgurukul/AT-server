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
import { ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { HolidaysService } from './holidays.service';

@ApiTags('holidays')
@Controller('holidays')
export class HolidaysController {
  constructor(private readonly holidaysService: HolidaysService) {}

  @Get()
  @Permissions('holiday:manage')
  list(
    @Query('orgId', ParseIntPipe) orgId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.holidaysService.list(orgId, { from: from ?? undefined, to: to ?? undefined });
  }

  @Post()
  @Permissions('holiday:manage')
  create(@Body() payload: CreateHolidayDto) {
    return this.holidaysService.create(payload);
  }

  @Patch(':id')
  @Permissions('holiday:manage')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() payload: UpdateHolidayDto,
  ) {
    return this.holidaysService.update(id, payload);
  }

  @Delete(':id')
  @Permissions('holiday:manage')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.holidaysService.delete(id);
  }
}
