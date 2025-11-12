import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { eq, inArray, lt } from 'drizzle-orm';

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
} from '../../db/schema';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './types/jwt-payload.interface';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClient: OAuth2Client;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId) {
      throw new Error('GOOGLE_CLIENT_ID must be configured');
    }

    this.googleClient = new OAuth2Client(clientId);
  }

  async login(payload: LoginDto) {
    const googleProfile = await this.verifyGoogleToken(payload.idToken);
    console.log('Google Profile:', googleProfile);
    if (!googleProfile.email || !googleProfile.sub) {
      throw new UnauthorizedException('Incomplete Google profile data');
    }

    const tokenEmail = googleProfile.email.toLowerCase();
    const requestEmail = payload.email?.toLowerCase();

    if (requestEmail && requestEmail !== tokenEmail) {
      throw new UnauthorizedException('Email mismatch between token and payload');
    }

    const db = this.databaseService.connection;
   console.log("Database Connection:", db);
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, tokenEmail));

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.status === 'suspended') {
      throw new UnauthorizedException('Account suspended. Reach out to HR.');
    }

    const now = new Date();
    const employeeDepartmentId = user.employeeDepartmentId
      ? Number(user.employeeDepartmentId)
      : null;

    if (!user.googleUserId) {
      await db
        .update(usersTable)
        .set({
          googleUserId: googleProfile.sub,
          avatarUrl: googleProfile.picture ?? user.avatarUrl,
          lastLoginAt: now,
          updatedAt: now,
        })
        .where(eq(usersTable.id, user.id));
    } else if (user.googleUserId !== googleProfile.sub) {
      throw new UnauthorizedException('Google user identifier mismatch');
    } else {
      await db
        .update(usersTable)
        .set({ lastLoginAt: now, updatedAt: now })
        .where(eq(usersTable.id, user.id));
    }

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
    const [userRecord] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        orgId: usersTable.orgId,
        managerId: usersTable.managerId,
        employeeDepartmentId: usersTable.employeeDepartmentId,
      })
      .from(usersTable)
      .where(eq(usersTable.id, payload.sub));

    if (!userRecord) {
      throw new UnauthorizedException('User no longer exists');
    }

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

    if (!user.employeeDepartmentId) {
      return {
        ...user,
        employeeDepartment: null,
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

  private async blacklistToken(
    token: string,
    tokenType: 'access' | 'refresh',
    userId: number,
  ) {
    try {
      const decoded = this.jwtService.decode(token) as { exp?: number } | null;
      if (!decoded?.exp) {
        throw new UnauthorizedException('Unable to decode token');
      }

      const expiresAt = new Date(decoded.exp * 1000);
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
