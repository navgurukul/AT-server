import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { envValidationSchema } from './config/env.validation';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
import { DatabaseModule } from './database/database.module';
import { AdminModule } from './modules/admin/admin.module';
import { DepartmentsModule } from './modules/departments/departments.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { CalendarModule } from './modules/calendar/calendar.module';
import { CostingModule } from './modules/costing/costing.module';
import { HolidaysModule } from './modules/holidays/holidays.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { LeavesModule } from './modules/leaves/leaves.module';
import { NotifyModule } from './modules/notify/notify.module';
import { OrgModule } from './modules/org/org.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { ReportsModule } from './modules/reports/reports.module';
import { TimesheetsModule } from './modules/timesheets/timesheets.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema: envValidationSchema,
    }),
    DatabaseModule,
    AuthModule,
    CalendarModule,
    HolidaysModule,
    RbacModule,
    UsersModule,
    OrgModule,
    ProjectsModule,
    TimesheetsModule,
    LeavesModule,
    ApprovalsModule,
    CostingModule,
    PayrollModule,
    ReportsModule,
    NotifyModule,
    AdminModule,
    AuditModule,
    JobsModule,
    DepartmentsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
  ],
})
export class AppModule {}
