import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, inArray, gte, lte } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import {
  usersTable,
  leavePoliciesTable,
  leaveBalancesTable,
  leaveAllocationLogsTable,
} from '../../db/schema';

@Injectable()
export class LeaveAllocationService {
  private readonly logger = new Logger(LeaveAllocationService.name);
  private readonly STANDARD_WORKDAY_HOURS = 8;

  constructor(private readonly databaseService: DatabaseService) {}

  async initialize(userId: number) {
    const db = this.databaseService.connection;

    // Step 1: Load User
    const [user] = await db
      .select({
        id: usersTable.id,
        orgId: usersTable.orgId,
        dateOfJoining: usersTable.dateOfJoining,
        employmentType: usersTable.employmentType,
        alumniStatus: usersTable.alumniStatus,
        lastLoginAt: usersTable.lastLoginAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    // Step 2: Validate Required Fields
    if (!user || !user.dateOfJoining || !user.employmentType) {
      this.logger.warn(`Skip leave allocation: Missing required fields for user ${userId}`);
      return { success: true, message: 'Skipped: Missing required user fields (dateOfJoining or employmentType)' };
    }

    const dateOfJoining = user.dateOfJoining as string;

    // Step 3: Join Date Validation (Joining date must be >= 2026-06-01)
    const joinDateStr = typeof user.dateOfJoining === 'string'
      ? user.dateOfJoining
      : new Date(user.dateOfJoining).toISOString().split('T')[0];

    if (joinDateStr < '2026-06-01') {
      this.logger.log(`Skip leave allocation: User joined before 2026-06-01 (joining date: ${joinDateStr})`);
      return { success: true, message: 'Exit: Join date is prior to 1 June 2026' };
    }

    // Step 4: Duplicate Processing Check
    const [existingLog] = await db
      .select()
      .from(leaveAllocationLogsTable)
      .where(
        and(
          eq(leaveAllocationLogsTable.userId, userId),
          eq(leaveAllocationLogsTable.allocationType, 'DAY_1')
        )
      )
      .limit(1);

    if (existingLog) {
      this.logger.log(`Skip leave allocation: DAY_1 allocation log already exists for user ${userId}`);
      return { success: true, message: 'Exit: DAY_1 allocation already completed' };
    }

    // Step 5: Load Day-1 Policies
    const policies = await db
      .select()
      .from(leavePoliciesTable)
      .where(
        and(
          eq(leavePoliciesTable.triggerEvent, 'DAY_1'),
          eq(leavePoliciesTable.orgId, user.orgId)
        )
      );

    if (policies.length === 0) {
      this.logger.warn(`Skip leave allocation: No active Day-1 policies configured for org ${user.orgId}`);
      return { success: true, message: 'Skipped: No active Day-1 policies found.' };
    }

    // Step 5.5: Existing Leave Balance Safety Check
    const day1LeaveTypeIds = Array.from(new Set(policies.map((p) => p.leaveTypeId)));
    const existingBalances = await db
      .select()
      .from(leaveBalancesTable)
      .where(
        and(
          eq(leaveBalancesTable.userId, userId),
          inArray(leaveBalancesTable.leaveTypeId, day1LeaveTypeIds)
        )
      );

    if (existingBalances.length > 0) {
      this.logger.log(`Existing leave balances found for user ${userId}. Logging completion and skipping allocation.`);
      try {
        await db.transaction(async (tx) => {
          await tx.insert(leaveAllocationLogsTable).values({
            userId,
            allocationType: 'DAY_1',
            processedAt: new Date(),
          });
        });
      } catch (logError: any) {
        if (logError && logError.code === '23505' && logError.constraint === 'uq_leave_allocation_log') {
          this.logger.log(`Concurrent DAY_1 log insertion detected for user ${userId}. Exiting successfully.`);
        } else {
          throw logError;
        }
      }
      return { success: true, message: 'Existing leave balances found. Created DAY_1 log and exited.' };
    }

    // Step 6: Employment Type Eligibility
    const typeMapping: { [key: string]: string } = {
      'FULL TIME EMPLOYEE': 'FTE',
      'FULL TIME CONSULTANT': 'FTC',
      'FULL TIME CONSULANT': 'FTC', // Handles typo "consulant" in DB
      'FULL TIME INTERN': 'FTI',
      'FTE': 'FTE',
      'FTC': 'FTC',
      'FTI': 'FTI',
    };

    const rawType = user.employmentType.trim().toUpperCase();
    const normalizedType = typeMapping[rawType] || rawType;

    const eligibleTypes = ['FTE', 'FTC', 'FTI'];
    const isEligible = eligibleTypes.includes(normalizedType);

    if (!isEligible) {
      this.logger.log(`User ${userId} is non-eligible (${user.employmentType}). Allocating 0 hours for all Day-1 leave types.`);
      try {
        await db.transaction(async (tx) => {
          for (const policy of policies) {
            await tx.insert(leaveBalancesTable).values({
              userId,
              leaveTypeId: policy.leaveTypeId,
              allocatedHours: '0.00',
              balanceHours: '0.00',
              bookedHours: '0.00',
              pendingHours: '0.00',
              asOfDate: dateOfJoining, // base calculations on dateOfJoining
            });
          }
          await tx.insert(leaveAllocationLogsTable).values({
            userId,
            allocationType: 'DAY_1',
            processedAt: new Date(),
          });
        });
        return { success: true, message: 'Processed non-eligible employee: allocated 0 hours.' };
      } catch (txError: any) {
        if (txError && txError.code === '23505' && txError.constraint === 'uq_leave_allocation_log') {
          this.logger.log(`Concurrent DAY_1 log insertion detected for user ${userId} (non-eligible). Exiting successfully.`);
          return { success: true, message: 'Allocation already processed concurrently.' };
        }
        throw txError;
      }
    }

    // Step 7: Alumni Evaluation
    const isAlumni =
      typeof user.alumniStatus === 'string' &&
      ['alumni', 'yes', 'true'].includes(user.alumniStatus.trim().toLowerCase());

    // Step 8: Leave Allocation Logic & Step 9: Create Allocation Log
    try {
      await db.transaction(async (tx) => {
        for (const policy of policies) {
          // Check employment type match (null-safe)
          const isPolicyEligible = Array.isArray(policy.validEmploymentTypes) && policy.validEmploymentTypes.some(
            (type) => type && type.trim().toUpperCase() === normalizedType
          );

          // Check alumni validation
          let isAlumniEligible = true;
          if (policy.requiresAlumni === true) {
            isAlumniEligible = isAlumni;
          } else if (policy.requiresAlumni === false) {
            isAlumniEligible = !isAlumni;
          }

          let allocationDays = 0;

          if (isPolicyEligible && isAlumniEligible) {
            if (policy.isProrated) {
              // Prorated Leave (CL & Wellness) using dateOfJoining
              const [joinYearStr, joinMonthStr, joinDayStr] = dateOfJoining.split('-');
              const joiningDay = parseInt(joinDayStr, 10);
              const joiningMonth = parseInt(joinMonthStr, 10);

              let eligibleMonths = 0;
              if (joiningDay <= 15) {
                eligibleMonths = 12 - joiningMonth + 1;
              } else {
                eligibleMonths = 12 - joiningMonth + 0.5;
              }

              const annualAllocation = parseFloat(policy.baseAllocationDays.toString());
              allocationDays = Math.floor((annualAllocation / 12) * eligibleMonths * 2) / 2;
            } else {
              // Fixed Leave using policy.baseAllocationDays
              allocationDays = parseFloat(policy.baseAllocationDays.toString());
            }
          } else {
            // Eligibility fails: allocatedDays = 0
            allocationDays = 0;
          }

          const hours = allocationDays * this.STANDARD_WORKDAY_HOURS;

          await tx.insert(leaveBalancesTable).values({
            userId,
            leaveTypeId: policy.leaveTypeId,
            allocatedHours: hours.toFixed(2),
            balanceHours: hours.toFixed(2),
            bookedHours: '0.00',
            pendingHours: '0.00',
            asOfDate: dateOfJoining, // base on dateOfJoining
          });
        }

        // Create Day-1 allocation log
        await tx.insert(leaveAllocationLogsTable).values({
          userId,
          allocationType: 'DAY_1',
          processedAt: new Date(),
        });
      });

      return { success: true, message: 'Day-1 leaves successfully allocated.' };
    } catch (error: any) {
      if (error && error.code === '23505' && error.constraint === 'uq_leave_allocation_log') {
        this.logger.log(`Concurrent DAY_1 log insertion detected for user ${userId}. Exiting successfully.`);
        return { success: true, message: 'Allocation already completed.' };
      }
      this.logger.error(`Error executing Day-1 leave allocation transaction for user ${userId}: ${error.message}`);
      throw error;
    }
  }

  @Cron('0 3 * * *', {
    name: 'day-91-leave-allocation',
    timeZone: 'Asia/Kolkata',
  })
  async runDay91AllocationCron() {
    this.logger.log('Starting daily DAY_91 leave allocation cron job...');
    try {
      const db = this.databaseService.connection;

      // Compute YYYY-MM-DD string for current date minus 90 days
      const today = new Date();
      const probationThresholdDate = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
      const year = probationThresholdDate.getUTCFullYear();
      const month = String(probationThresholdDate.getUTCMonth() + 1).padStart(2, '0');
      const day = String(probationThresholdDate.getUTCDate()).padStart(2, '0');
      const probationThresholdStr = `${year}-${month}-${day}`;

      // Find all candidate users
      const candidates = await db
        .select({
          id: usersTable.id,
          orgId: usersTable.orgId,
          dateOfJoining: usersTable.dateOfJoining,
          employmentType: usersTable.employmentType,
          alumniStatus: usersTable.alumniStatus,
        })
        .from(usersTable)
        .where(
          and(
            gte(usersTable.dateOfJoining, '2026-06-01'),
            lte(usersTable.dateOfJoining, probationThresholdStr)
          )
        );

      this.logger.log(`Found ${candidates.length} potential candidates for DAY_91 allocation.`);

      for (const user of candidates) {
        try {
          await this.processDay91AllocationForUser(user.id);
        } catch (userError: any) {
          this.logger.error(`Failed to process DAY_91 allocation for user ${user.id}: ${userError.message}`);
        }
      }
      this.logger.log('Daily DAY_91 leave allocation cron job completed.');
    } catch (cronError: any) {
      this.logger.error(`Error in DAY_91 leave allocation cron job: ${cronError.message}`);
    }
  }

  async processDay91AllocationForUser(userId: number) {
    const db = this.databaseService.connection;

    // Load User details
    const [user] = await db
      .select({
        id: usersTable.id,
        orgId: usersTable.orgId,
        dateOfJoining: usersTable.dateOfJoining,
        employmentType: usersTable.employmentType,
        alumniStatus: usersTable.alumniStatus,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user || !user.dateOfJoining || !user.employmentType) {
      this.logger.warn(`Skip DAY_91 allocation: Missing required fields for user ${userId}`);
      return { success: true, message: 'Skipped: Missing required user fields.' };
    }

    const dateOfJoining = user.dateOfJoining as string;

    // Check if DAY_91 log already exists (Source of Truth)
    const [existingLog] = await db
      .select()
      .from(leaveAllocationLogsTable)
      .where(
        and(
          eq(leaveAllocationLogsTable.userId, userId),
          eq(leaveAllocationLogsTable.allocationType, 'DAY_91')
        )
      )
      .limit(1);

    if (existingLog) {
      return { success: true, message: 'Exit: DAY_91 allocation already completed' };
    }

    // Load DAY_91 Policies
    const policies = await db
      .select()
      .from(leavePoliciesTable)
      .where(
        and(
          eq(leavePoliciesTable.triggerEvent, 'DAY_91'),
          eq(leavePoliciesTable.orgId, user.orgId)
        )
      );

    if (policies.length === 0) {
      this.logger.warn(`Skip DAY_91 allocation: No active DAY_91 policies configured for org ${user.orgId}`);
      return { success: true, message: 'Skipped: No active DAY_91 policies found.' };
    }

    // The early exit based on existingBalances is removed so that missing balances
    // are allocated policy-by-policy. Existing balances are skipped individually
    // via the checkExisting query inside the transaction, and the DAY_91 log is
    // written once all missing balances are successfully processed.

    // Employment Type Eligibility mapping
    const typeMapping: { [key: string]: string } = {
      'FULL TIME EMPLOYEE': 'FTE',
      'FULL TIME CONSULTANT': 'FTC',
      'FULL TIME CONSULANT': 'FTC', // Handles typo "consulant" in DB
      'FULL TIME INTERN': 'FTI',
      'FTE': 'FTE',
      'FTC': 'FTC',
      'FTI': 'FTI',
    };

    const rawType = user.employmentType.trim().toUpperCase();
    const normalizedType = typeMapping[rawType] || rawType;

    const eligibleTypes = ['FTE', 'FTC', 'FTI'];
    const isEligible = eligibleTypes.includes(normalizedType);

    if (!isEligible) {
      this.logger.log(`User ${userId} is non-eligible for DAY_91 (${user.employmentType}). Skipping balance allocation and logging.`);
      try {
        await db.transaction(async (tx) => {
          await tx.insert(leaveAllocationLogsTable).values({
            userId,
            allocationType: 'DAY_91',
            processedAt: new Date(),
          });
        });
        return { success: true, message: 'Processed non-eligible employee: logged DAY_91 with no balances.' };
      } catch (txError: any) {
        if (txError && txError.code === '23505' && txError.constraint === 'uq_leave_allocation_log') {
          this.logger.log(`Concurrent DAY_91 log insertion detected for user ${userId} (non-eligible). Exiting successfully.`);
          return { success: true, message: 'Allocation already processed concurrently.' };
        }
        throw txError;
      }
    }

    // Alumni status check
    const isAlumni =
      typeof user.alumniStatus === 'string' &&
      ['alumni', 'yes', 'true'].includes(user.alumniStatus.trim().toLowerCase());

    // Execute DAY_91 Allocation inside transaction
    try {
      await db.transaction(async (tx) => {
        for (const policy of policies) {
          // Double-check if balance already exists to prevent modifying existing balances
          const [checkExisting] = await tx
            .select()
            .from(leaveBalancesTable)
            .where(
              and(
                eq(leaveBalancesTable.userId, userId),
                eq(leaveBalancesTable.leaveTypeId, policy.leaveTypeId)
              )
            )
            .limit(1);

          if (checkExisting) {
            continue; // Do not modify or overwrite existing balance
          }

          // Check individual eligibility
          const isPolicyEligible = Array.isArray(policy.validEmploymentTypes) && policy.validEmploymentTypes.some(
            (type) => type && type.trim().toUpperCase() === normalizedType
          );

          let isAlumniEligible = true;
          if (policy.requiresAlumni === true) {
            isAlumniEligible = isAlumni;
          } else if (policy.requiresAlumni === false) {
            isAlumniEligible = !isAlumni;
          }

          let allocationDays = 0;

          if (isPolicyEligible && isAlumniEligible) {
            if (policy.isProrated) {
              // Prorated logic based on original dateOfJoining
              const [joinYearStr, joinMonthStr, joinDayStr] = dateOfJoining.split('-');
              const joiningDay = parseInt(joinDayStr, 10);
              const joiningMonth = parseInt(joinMonthStr, 10);

              let eligibleMonths = 0;
              if (joiningDay <= 15) {
                eligibleMonths = 12 - joiningMonth + 1;
              } else {
                eligibleMonths = 12 - joiningMonth + 0.5;
              }

              const annualAllocation = parseFloat(policy.baseAllocationDays.toString());
              allocationDays = Math.floor((annualAllocation / 12) * eligibleMonths * 2) / 2;
            } else {
              allocationDays = parseFloat(policy.baseAllocationDays.toString());
            }
          }

          const hours = allocationDays * this.STANDARD_WORKDAY_HOURS;

          await tx.insert(leaveBalancesTable).values({
            userId,
            leaveTypeId: policy.leaveTypeId,
            allocatedHours: hours.toFixed(2),
            balanceHours: hours.toFixed(2),
            bookedHours: '0.00',
            pendingHours: '0.00',
            asOfDate: dateOfJoining,
          });
        }

        // Insert DAY_91 log as the final step inside the transaction
        await tx.insert(leaveAllocationLogsTable).values({
          userId,
          allocationType: 'DAY_91',
          processedAt: new Date(),
        });
      });

      return { success: true, message: 'DAY_91 leaves successfully allocated.' };
    } catch (error: any) {
      if (error && error.code === '23505' && error.constraint === 'uq_leave_allocation_log') {
        this.logger.log(`Concurrent DAY_91 log insertion detected for user ${userId}. Exiting successfully.`);
        return { success: true, message: 'Allocation already completed.' };
      }
      throw error;
    }
  }
}
