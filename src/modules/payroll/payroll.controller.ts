import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { PayrollService } from './payroll.service';

@ApiTags('payroll')
@Controller('payroll')
export class PayrollController {
  constructor(private readonly payrollService: PayrollService) {}

  @Post('freeze')
  @ApiQuery({ name: 'month', required: true, type: Number })
  @ApiQuery({ name: 'year', required: true, type: Number })
  @Permissions('payroll:freeze')
  freeze(@Query('month') month: string, @Query('year') year: string) {
    return this.payrollService.freezeWindow(
      Number.parseInt(month, 10),
      Number.parseInt(year, 10),
    );
  }

  @Get('export')
  @ApiQuery({ name: 'month', required: true, type: Number })
  @ApiQuery({ name: 'year', required: true, type: Number })
  @Permissions('payroll:export')
  export(@Query('month') month: string, @Query('year') year: string) {
    return this.payrollService.exportPayroll(
      Number.parseInt(month, 10),
      Number.parseInt(year, 10),
    );
  }
}
