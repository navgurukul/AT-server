import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { and, count, eq, gte, inArray, lt } from 'drizzle-orm';

import { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { DatabaseService } from '../../database/database.service';
import {
  authBlacklistedTokensTable,
  employeeDepartmentsTable,
  permissionsTable,
  rolePermissionsTable,
  rolesTable,
  userRolesTable,
  usersTable,
  backfillCountersTable,
  backfillDatesTable,
  timesheetsTable,
  orgsTable,
} from '../../db/schema';
import { LeaveAllocationService } from '../leave-allocation/leave-allocation.service';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './types/jwt-payload.interface';
import { validateUserAccess } from '../../common/utils/access-control.util';

@Injectable()
export class AuthService {
  private static readonly MAX_BACKFILL_PER_MONTH = 3;
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClient: OAuth2Client;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly leaveAllocationService: LeaveAllocationService,
  ) {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId) {
      throw new Error('GOOGLE_CLIENT_ID must be configured');
    }

    this.googleClient = new OAuth2Client(clientId);
  }

  async login(payload: LoginDto) {
    const googleProfile = await this.verifyGoogleToken(payload.idToken);
    if (!googleProfile.email || !googleProfile.sub) {
      throw new UnauthorizedException('Incomplete Google profile data');
    }

    const tokenEmail = googleProfile.email.toLowerCase();
    const requestEmail = payload.email?.toLowerCase();

    if (requestEmail && requestEmail !== tokenEmail) {
      throw new UnauthorizedException('Email mismatch between token and payload');
    }

    const db = this.databaseService.connection;
    const [userResult] = await db
      .select({
        user: usersTable,
        timezone: orgsTable.timezone,
      })
      .from(usersTable)
      .leftJoin(orgsTable, eq(usersTable.orgId, orgsTable.id))
      .where(eq(usersTable.email, tokenEmail));

    if (!userResult || !userResult.user) {
      throw new UnauthorizedException('Please login using your Team ID. Your email was not found in the PnC sheet. Please contact the PnC Team for assistance.');
    }

    const { user, timezone } = userResult;

    // Validate access using our centralized validation utility
    validateUserAccess({
      id: Number(user.id),
      email: user.email,
      status: user.status,
      dateOfExit: user.dateOfExit,
      timezone,
    });

    const now = new Date();
    const employeeDepartmentId = user.employeeDepartmentId
      ? Number(user.employeeDepartmentId)
      : null;

    let targetLastLoginAt: Date | null = now;

    const isNewUser = this.leaveAllocationService.hasJoinedLessThanOneMonthAgo(user.dateOfJoining, now);

    if (isNewUser) {
      const leaveAllocated = await this.leaveAllocationService.hasLeaveBeenAllocated(Number(user.id));
      if (!leaveAllocated) {
        const hasRequiredFields = this.leaveAllocationService.hasRequiredFieldsForAllocation(user);
        if (hasRequiredFields) {
          try {
            await this.leaveAllocationService.initialize(Number(user.id));
          } catch (error) {
            this.logger.error(`Leave allocation failed for user ${user.id}: ${error instanceof Error ? error.message : error}`);
          }
          targetLastLoginAt = now;
        } else {
          // Required fields are missing
          if (!user.lastLoginAt) {
            // First time missing fields encountered (or first login after forced logout)
            // Record start of 24-hour period
            targetLastLoginAt = now;
          } else {
            const elapsedMs = now.getTime() - new Date(user.lastLoginAt).getTime();
            const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
            if (elapsedMs >= TWENTY_FOUR_HOURS_MS) {
              // 24 hours have elapsed: reset first-login flow for this specific validation flow
              targetLastLoginAt = now;
            } else {
              // Preserve original timestamp during the 24-hour period; do not repeatedly reset
              targetLastLoginAt = new Date(user.lastLoginAt);
            }
          }
        }
      } else {
        targetLastLoginAt = now;
      }
    } else {
      const isFirstLogin = !user.lastLoginAt;
      if (isFirstLogin) {
        try {
          await this.leaveAllocationService.initialize(Number(user.id));
        } catch (error) {
          this.logger.error(`Leave allocation failed for user ${user.id}: ${error instanceof Error ? error.message : error}`);
        }
      }
      targetLastLoginAt = now;
    }

    const userUpdatePayload: Partial<typeof usersTable.$inferInsert> = {
      updatedAt: now,
    };

    if (!user.googleUserId) {
      userUpdatePayload.googleUserId = googleProfile.sub;
      userUpdatePayload.avatarUrl = googleProfile.picture ?? user.avatarUrl;
    } else if (user.googleUserId !== googleProfile.sub) {
      throw new UnauthorizedException('Google user identifier mismatch');
    }

    const shouldUpdateLastLogin =
      !user.lastLoginAt ||
      (targetLastLoginAt && targetLastLoginAt.getTime() !== new Date(user.lastLoginAt).getTime());

    if (shouldUpdateLastLogin) {
      userUpdatePayload.lastLoginAt = targetLastLoginAt;
    }

    await db
      .update(usersTable)
      .set(userUpdatePayload)
      .where(eq(usersTable.id, user.id));

    // Assign employee role if user doesn't have any roles
    await this.assignEmployeeRoleIfNeeded(Number(user.id));

    let employeeDepartment:
      | {
          id: number;
          name: string;
          code: string | null;
          description: string | null;
        }
      | null = null;
    if (employeeDepartmentId) {
      const [employeeDepartmentRow] = await db
        .select({
          id: employeeDepartmentsTable.id,
          name: employeeDepartmentsTable.name,
          code: employeeDepartmentsTable.code,
          description: employeeDepartmentsTable.description,
        })
        .from(employeeDepartmentsTable)
        .where(eq(employeeDepartmentsTable.id, employeeDepartmentId))
        .limit(1);

      if (employeeDepartmentRow) {
        employeeDepartment = {
          id: Number(employeeDepartmentRow.id),
          name: employeeDepartmentRow.name,
          code: employeeDepartmentRow.code ?? null,
          description: employeeDepartmentRow.description ?? null,
        };
      }
    }

    const roles = await this.getUserRoles(Number(user.id));
    const permissions = await this.getUserPermissions(Number(user.id));

    const jwtPayload: JwtPayload = {
      sub: Number(user.id),
      email: user.email,
      orgId: Number(user.orgId),
      roles,
      permissions,
      managerId: user.managerId ? Number(user.managerId) : null,
      employeeDepartmentId,
    };

    const accessToken = await this.signAccessToken(jwtPayload);
    const refreshToken = await this.signRefreshToken(jwtPayload);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.getAccessExpiry(),
      user: {
        id: Number(user.id),
        email: user.email,
        name: user.name,
        orgId: Number(user.orgId),
        roles,
        permissions,
        managerId: user.managerId ? Number(user.managerId) : null,
        employeeDepartmentId,
        employeeDepartment,
        avatarUrl: googleProfile.picture ?? user.avatarUrl ?? null,
      },
    };
  }

  async refreshToken(refreshToken: string) {
    await this.ensureTokenNotBlacklisted(refreshToken);

    let payload: JwtPayload;

    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch (error) {
      this.logger.warn(`Failed refresh token verification: ${error instanceof Error ? error.message : error}`);
      throw new UnauthorizedException('Invalid refresh token');
    }

    const db = this.databaseService.connection;
    const [userResult] = await db
      .select({
        user: {
          id: usersTable.id,
          email: usersTable.email,
          orgId: usersTable.orgId,
          managerId: usersTable.managerId,
          employeeDepartmentId: usersTable.employeeDepartmentId,
          status: usersTable.status,
          dateOfExit: usersTable.dateOfExit,
          dateOfJoining: usersTable.dateOfJoining,
          employmentType: usersTable.employmentType,
          lastLoginAt: usersTable.lastLoginAt,
        },
        timezone: orgsTable.timezone,
      })
      .from(usersTable)
      .leftJoin(orgsTable, eq(usersTable.orgId, orgsTable.id))
      .where(eq(usersTable.id, payload.sub));

    if (!userResult || !userResult.user) {
      throw new UnauthorizedException('User no longer exists');
    }

    const { user: userRecord, timezone } = userResult;

    // Validate access using our centralized validation utility
    validateUserAccess({
      id: Number(userRecord.id),
      email: userRecord.email,
      status: userRecord.status,
      dateOfExit: userRecord.dateOfExit,
      timezone,
    });

    // Validate new user leave allocation flow (24h grace period for missing required fields)
    await this.validateNewUserGracePeriod(
      {
        id: Number(userRecord.id),
        dateOfJoining: userRecord.dateOfJoining,
        employmentType: userRecord.employmentType,
        lastLoginAt: userRecord.lastLoginAt ? new Date(userRecord.lastLoginAt) : null,
      },
      refreshToken,
      'refresh',
    );

    const roles = await this.getUserRoles(payload.sub);
    const permissions = await this.getUserPermissions(payload.sub);
    const managerId = userRecord.managerId
      ? Number(userRecord.managerId)
      : null;
    const employeeDepartmentId = userRecord.employeeDepartmentId
      ? Number(userRecord.employeeDepartmentId)
      : null;

    const enrichedPayload: JwtPayload = {
      sub: Number(userRecord.id),
      email: userRecord.email,
      orgId: Number(userRecord.orgId),
      roles,
      permissions,
      managerId,
      employeeDepartmentId,
    };

    const newAccessToken = await this.signAccessToken(enrichedPayload);
    const newRefreshToken = await this.signRefreshToken(enrichedPayload);

    await this.blacklistToken(refreshToken, 'refresh', payload.sub);

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn: this.getAccessExpiry(),
    };
  }

  async logout(userId: number, token: string) {
    await this.blacklistToken(token, 'access', userId);
    await this.cleanupExpiredTokens();
    return { success: true };
  }

  async getProfile(user: AuthenticatedUser) {
    const db = this.databaseService.connection;
    const backfill = await this.getBackfillQuota(user.id, user.orgId);

    if (!user.employeeDepartmentId) {
      return {
        ...user,
        employeeDepartment: null,
        backfill,
      };
    }

    const [employeeDepartment] = await db
      .select({
        id: employeeDepartmentsTable.id,
        name: employeeDepartmentsTable.name,
        code: employeeDepartmentsTable.code,
        description: employeeDepartmentsTable.description,
      })
      .from(employeeDepartmentsTable)
      .where(eq(employeeDepartmentsTable.id, user.employeeDepartmentId))
      .limit(1);

    return {
      ...user,
      employeeDepartment: employeeDepartment
        ? {
            id: Number(employeeDepartment.id),
            name: employeeDepartment.name,
            code: employeeDepartment.code ?? null,
            description: employeeDepartment.description ?? null,
          }
        : null,
      backfill,
    };
  }

  private async getUserRoles(userId: number): Promise<string[]> {
    const db = this.databaseService.connection;
    const result = await db
      .select({ key: rolesTable.key })
      .from(rolesTable)
      .innerJoin(userRolesTable, eq(userRolesTable.roleId, rolesTable.id))
      .where(eq(userRolesTable.userId, userId));

    const roleKeys = Array.from(new Set(result.map((row) => row.key)));
    if (roleKeys.length === 0) {
      roleKeys.push('employee');
    }

    return roleKeys;
  }

  private async assignEmployeeRoleIfNeeded(userId: number): Promise<void> {
    const db = this.databaseService.connection;

    // Check if user already has any roles
    const existingRoles = await db
      .select({ roleId: userRolesTable.roleId })
      .from(userRolesTable)
      .where(eq(userRolesTable.userId, userId));

    if (existingRoles.length > 0) {
      // User already has roles, no need to assign employee role
      return;
    }

    // Get the employee role ID
    const [employeeRole] = await db
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .where(eq(rolesTable.key, 'employee'));

    if (!employeeRole) {
      this.logger.warn('Employee role not found in database');
      return;
    }

    // Assign employee role to user
    try {
      await db.insert(userRolesTable).values({
        userId,
        roleId: employeeRole.id,
      });
      this.logger.log(`Assigned employee role to user ${userId}`);
    } catch (error) {
      // If the assignment fails (e.g., duplicate key), just log and continue
      // The user will still get 'employee' as a default role from getUserRoles
      this.logger.warn(`Failed to assign employee role to user ${userId}: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async getUserPermissions(userId: number): Promise<string[]> {
    const db = this.databaseService.connection;
    const roleIdsResult = await db
      .select({ roleId: userRolesTable.roleId })
      .from(userRolesTable)
      .where(eq(userRolesTable.userId, userId));

    if (roleIdsResult.length === 0) {
      return [];
    }

    const roleIds = roleIdsResult.map((row) => row.roleId);

    const permissionsResult = await db
      .select({ key: permissionsTable.key })
      .from(permissionsTable)
      .innerJoin(
        rolePermissionsTable,
        eq(rolePermissionsTable.permissionId, permissionsTable.id),
      )
      .where(inArray(rolePermissionsTable.roleId, roleIds));

    return Array.from(new Set(permissionsResult.map((row) => row.key)));
  }

  async forceLogoutUser(
    userId: number,
    token?: string,
    tokenType: 'access' | 'refresh' = 'access',
  ): Promise<void> {
    const db = this.databaseService.connection;
    await db
      .update(usersTable)
      .set({
        lastLoginAt: null,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, userId));

    if (token) {
      await this.blacklistToken(token, tokenType, userId);
    }
  }

  async validateNewUserGracePeriod(
    user: {
      id: number;
      dateOfJoining?: string | Date | null;
      employmentType?: string | null;
      lastLoginAt?: Date | string | null;
    },
    token?: string,
    tokenType: 'access' | 'refresh' = 'access',
  ): Promise<void> {
    const now = new Date();

    // 1. Check Date of Joining: apply only if user joined less than 1 month ago
    if (!this.leaveAllocationService.hasJoinedLessThanOneMonthAgo(user.dateOfJoining, now)) {
      return;
    }

    // 2. Check Leave Allocation: if already allocated, allow normal access
    const leaveAllocated = await this.leaveAllocationService.hasLeaveBeenAllocated(Number(user.id));
    if (leaveAllocated) {
      return;
    }

    // 3. Check Required Fields
    const hasRequiredFields = this.leaveAllocationService.hasRequiredFieldsForAllocation(user);
    if (hasRequiredFields) {
      // If required fields are updated, let existing leave allocation flow handle it
      try {
        await this.leaveAllocationService.initialize(Number(user.id));
      } catch (error) {
        this.logger.error(
          `Leave allocation failed for user ${user.id}: ${error instanceof Error ? error.message : error}`,
        );
      }
      return;
    }

    // Required fields are missing
    if (!user.lastLoginAt) {
      // If lastLoginAt is null during an authenticated action, the user was either forcibly logged out
      // or their session has reset. Require re-login.
      if (token) {
        await this.blacklistToken(token, tokenType, Number(user.id));
      }
      throw new UnauthorizedException(
        'Required profile information is incomplete. Session expired. Please log in again.',
      );
    }

    const elapsedMs = now.getTime() - new Date(user.lastLoginAt).getTime();
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

    if (elapsedMs < TWENTY_FOUR_HOURS_MS) {
      // Within 24-hour window: allow user to continue using the website, do not reset timestamp
      return;
    }

    // 4. Recheck after 24 hours: 24 hours have elapsed and required fields are still missing
    // Set last_login_at to NULL, expire/invalidate token, automatically log user out
    await this.forceLogoutUser(Number(user.id), token, tokenType);
    throw new UnauthorizedException(
      'Required profile information is incomplete. Your 24-hour grace period has expired. Please log in again.',
    );
  }

  async blacklistToken(
    token: string,
    tokenType: 'access' | 'refresh',
    userId: number,
  ) {
    try {
      const decoded = this.jwtService.decode(token) as { exp?: number } | null;
      const expiresAt = decoded?.exp
        ? new Date(decoded.exp * 1000)
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const db = this.databaseService.connection;

      await db
        .insert(authBlacklistedTokensTable)
        .values({
          token,
          tokenType,
          userId,
          expiresAt,
        })
        .onConflictDoNothing();
    } catch (error) {
      this.logger.warn(`Failed to blacklist token: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async ensureTokenNotBlacklisted(token: string) {
    const db = this.databaseService.connection;
    const [blacklisted] = await db
      .select({ id: authBlacklistedTokensTable.id })
      .from(authBlacklistedTokensTable)
      .where(eq(authBlacklistedTokensTable.token, token));

    if (blacklisted) {
      throw new UnauthorizedException('Token has been revoked');
    }
  }

  private async cleanupExpiredTokens() {
    const db = this.databaseService.connection;
    await db
      .delete(authBlacklistedTokensTable)
      .where(lt(authBlacklistedTokensTable.expiresAt, new Date()));
  }

  private async getBackfillQuota(userId: number, orgId: number) {
    const now = new Date();
    const { SalaryCycleUtil } = await import('../../common/utils/salary-cycle.util');
    const currentCycle = SalaryCycleUtil.getCurrentSalaryCycle(now);
    
    const year = currentCycle.year;
    const month = currentCycle.month;

    const [counter] = await this.databaseService.connection
      .select({
        used: backfillCountersTable.used,
        limit: backfillCountersTable.limit,
      })
      .from(backfillCountersTable)
      .where(
        and(
          eq(backfillCountersTable.orgId, orgId),
          eq(backfillCountersTable.userId, userId),
          eq(backfillCountersTable.year, year),
          eq(backfillCountersTable.month, month),
        ),
      )
      .limit(1);

    const usage =
      counter && counter.used !== null && counter.used !== undefined
        ? Number(counter.used)
        : await this.countBackfilledDaysForCycle(userId, currentCycle, now, orgId);

    const limit =
      counter && counter.limit !== null && counter.limit !== undefined
        ? Number(counter.limit)
        : AuthService.MAX_BACKFILL_PER_MONTH;

    const remaining = Math.max(limit - usage, 0);
    return {
      limit,
      remaining,
    };
  }

  private async countBackfilledDaysForCycle(
    userId: number,
    cycle: { year: number; month: number },
    now: Date,
    orgId?: number,
  ) {
    const db = this.databaseService.connection;

    const year = cycle.year;
    const month = cycle.month;
    // Count actual backfill entries from the backfill_dates table for this cycle
    const conditions = [
      eq(backfillDatesTable.userId, userId),
      orgId ? eq(backfillDatesTable.orgId, orgId) : undefined,
      eq(backfillDatesTable.year, year),
      eq(backfillDatesTable.month, month),
    ].filter((c): c is NonNullable<typeof c> => Boolean(c));

    const [{ value: backfillCount }] = await db
      .select({ value: count(backfillDatesTable.id) })
      .from(backfillDatesTable)
      .where(and(...conditions));

    return Number(backfillCount ?? 0);
  }

  private async countBackfilledDaysForMonth(
    userId: number,
    referenceDate: Date,
    now: Date,
    orgId?: number,
  ) {
    const db = this.databaseService.connection;

    const startOfMonth = this.normalizeDate(
      new Date(
        Date.UTC(
          referenceDate.getUTCFullYear(),
          referenceDate.getUTCMonth(),
          1,
        ),
      ),
    );
    const startOfNextMonth = this.normalizeDate(
      new Date(
        Date.UTC(
          referenceDate.getUTCFullYear(),
          referenceDate.getUTCMonth() + 1,
          1,
        ),
      ),
    );

    const today = this.normalizeDate(now);
    const upperBound = today < startOfNextMonth ? today : startOfNextMonth;

    const conditions = [
      eq(timesheetsTable.userId, userId),
      orgId ? eq(timesheetsTable.orgId, orgId) : undefined,
      lt(timesheetsTable.workDate, upperBound),
      gte(timesheetsTable.workDate, startOfMonth),
    ].filter((c): c is NonNullable<typeof c> => Boolean(c));

    const [{ value }] = await db
      .select({ value: count(timesheetsTable.id) })
      .from(timesheetsTable)
      .where(and(...conditions));

    return Number(value ?? 0);
  }

  private normalizeDate(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  private async signAccessToken(payload: JwtPayload) {
    return this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.getAccessExpiry(),
    });
  }

  private async signRefreshToken(payload: JwtPayload) {
    return this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.getRefreshExpiry(),
    });
  }

  private getAccessExpiry() {
    return this.configService.get<string>('JWT_ACCESS_EXPIRES_IN') ?? '15m';
  }

  private getRefreshExpiry() {
    return this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '7d';
  }

  private async verifyGoogleToken(idToken: string): Promise<TokenPayload> {
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: this.configService.get<string>('GOOGLE_CLIENT_ID'),
      });

      const payload = ticket.getPayload();
      if (!payload) {
        throw new UnauthorizedException('Unable to verify Google credentials');
      }

      return payload;
    } catch (error) {
      this.logger.error(`Google token verification failed: ${error instanceof Error ? error.message : error}`);
      throw new UnauthorizedException('Invalid Google ID token');
    }
  }
}
