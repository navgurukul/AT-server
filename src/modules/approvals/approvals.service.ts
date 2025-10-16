import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import {
  approvalsTable,
  leaveRequestsTable,
  leaveTypesTable,
  timesheetsTable,
  usersTable,
} from '../../db/schema';

interface ApprovalFilters {
  subjectType?: string;
  state?: string;
}

@Injectable()
export class ApprovalsService {
  constructor(private readonly database: DatabaseService) {}

  async listApprovals(params: ApprovalFilters) {
    const db = this.database.connection;

    const conditions: any[] = [];
    if (params.subjectType) {
      conditions.push(eq(approvalsTable.subjectType, params.subjectType));
    }
    if (params.state) {
      conditions.push(eq(approvalsTable.decision, params.state as any));
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const approvals = await db
      .select({
        id: approvalsTable.id,
        orgId: approvalsTable.orgId,
        subjectType: approvalsTable.subjectType,
        subjectId: approvalsTable.subjectId,
        decision: approvalsTable.decision,
        comment: approvalsTable.comment,
        decidedAt: approvalsTable.decidedAt,
        createdAt: approvalsTable.createdAt,
        approver: {
          id: usersTable.id,
          name: usersTable.name,
          email: usersTable.email,
        },
      })
      .from(approvalsTable)
      .leftJoin(usersTable, eq(approvalsTable.approverId, usersTable.id))
      .where(whereClause)
      .orderBy(desc(approvalsTable.createdAt), desc(approvalsTable.id));

    if (approvals.length === 0) {
      return [];
    }

    const timesheetIds = [
      ...new Set(
        approvals
          .filter((approval) => approval.subjectType === 'timesheet')
          .map((approval) => approval.subjectId),
      ),
    ];
    const leaveRequestIds = [
      ...new Set(
        approvals
          .filter((approval) => approval.subjectType === 'leave_request')
          .map((approval) => approval.subjectId),
      ),
    ];

    const timesheetDetails =
      timesheetIds.length === 0
        ? []
        : await db
            .select({
              id: timesheetsTable.id,
              userId: timesheetsTable.userId,
              workDate: timesheetsTable.workDate,
              state: timesheetsTable.state,
              totalHours: timesheetsTable.totalHours,
              submittedAt: timesheetsTable.submittedAt,
              approvedAt: timesheetsTable.approvedAt,
            })
            .from(timesheetsTable)
            .where(inArray(timesheetsTable.id, timesheetIds))
            .orderBy(asc(timesheetsTable.workDate));

    const leaveDetails =
      leaveRequestIds.length === 0
        ? []
        : await db
            .select({
              id: leaveRequestsTable.id,
              userId: leaveRequestsTable.userId,
              leaveTypeId: leaveRequestsTable.leaveTypeId,
              startDate: leaveRequestsTable.startDate,
              endDate: leaveRequestsTable.endDate,
              hours: leaveRequestsTable.hours,
              state: leaveRequestsTable.state,
              reason: leaveRequestsTable.reason,
              createdAt: leaveRequestsTable.createdAt,
              leaveTypeCode: leaveTypesTable.code,
              leaveTypeName: leaveTypesTable.name,
            })
            .from(leaveRequestsTable)
            .innerJoin(
              leaveTypesTable,
              eq(leaveRequestsTable.leaveTypeId, leaveTypesTable.id),
            )
            .where(inArray(leaveRequestsTable.id, leaveRequestIds))
            .orderBy(desc(leaveRequestsTable.createdAt));

    const timesheetMap = new Map(
      timesheetDetails.map((details) => [details.id, details]),
    );
    const leaveMap = new Map(leaveDetails.map((details) => [details.id, details]));

    return approvals.map((approval) => {
      let subject: Record<string, unknown> | null = null;

      if (approval.subjectType === 'timesheet') {
        const ts = timesheetMap.get(approval.subjectId);
        if (ts) {
          subject = {
            type: 'timesheet',
            id: ts.id,
            userId: ts.userId,
            workDate: ts.workDate,
            state: ts.state,
            totalHours: ts.totalHours,
            submittedAt: ts.submittedAt,
            approvedAt: ts.approvedAt,
          };
        }
      } else if (approval.subjectType === 'leave_request') {
        const lr = leaveMap.get(approval.subjectId);
        if (lr) {
          subject = {
            type: 'leave_request',
            id: lr.id,
            userId: lr.userId,
            leaveTypeId: lr.leaveTypeId,
            leaveTypeCode: lr.leaveTypeCode,
            leaveTypeName: lr.leaveTypeName,
            startDate: lr.startDate,
            endDate: lr.endDate,
            hours: lr.hours,
            state: lr.state,
            reason: lr.reason,
            createdAt: lr.createdAt,
          };
        }
      }

      return {
        ...approval,
        subject,
      };
    });
  }
}
