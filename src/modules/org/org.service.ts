import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import {
  leavePoliciesTable,
  leaveTypesTable,
  orgsTable,
  payrollWindowsTable,
} from '../../db/schema';

@Injectable()
export class OrgService {
  constructor(private readonly database: DatabaseService) {}

  async getConfiguration(orgId: number) {
    const db = this.database.connection;

    const [org] = await db
      .select({
        id: orgsTable.id,
        name: orgsTable.name,
        code: orgsTable.code,
        status: orgsTable.status,
        timezone: orgsTable.timezone,
        createdAt: orgsTable.createdAt,
      })
      .from(orgsTable)
      .where(eq(orgsTable.id, orgId))
      .limit(1);

    if (!org) {
      throw new NotFoundException(`Organisation with id ${orgId} not found`);
    }

    const leavePolicies = await db
      .select({
        id: leavePoliciesTable.id,
        leaveTypeId: leavePoliciesTable.leaveTypeId,
        leaveTypeCode: leaveTypesTable.code,
        leaveTypeName: leaveTypesTable.name,
        paid: leaveTypesTable.paid,
        requiresApproval: leaveTypesTable.requiresApproval,
        accrualRule: leavePoliciesTable.accrualRule,
        carryForwardRule: leavePoliciesTable.carryForwardRule,
        maxBalance: leavePoliciesTable.maxBalance,
        createdAt: leavePoliciesTable.createdAt,
        updatedAt: leavePoliciesTable.updatedAt,
      })
      .from(leavePoliciesTable)
      .innerJoin(
        leaveTypesTable,
        eq(leavePoliciesTable.leaveTypeId, leaveTypesTable.id),
      )
      .where(eq(leavePoliciesTable.orgId, orgId));

    const payrollWindows = await db
      .select({
        id: payrollWindowsTable.id,
        month: payrollWindowsTable.month,
        year: payrollWindowsTable.year,
        freezeState: payrollWindowsTable.freezeState,
        frozenAt: payrollWindowsTable.frozenAt,
        updatedAt: payrollWindowsTable.updatedAt,
      })
      .from(payrollWindowsTable)
      .where(eq(payrollWindowsTable.orgId, orgId))
      .orderBy(desc(payrollWindowsTable.year), desc(payrollWindowsTable.month))
      .limit(12);

    const activeWindow = payrollWindows.find(
      (window) => window.freezeState === 'open',
    );

    return {
      organisation: org,
      leavePolicies,
      payrollWindows,
      activePayrollWindow: activeWindow ?? null,
    };
  }
}
