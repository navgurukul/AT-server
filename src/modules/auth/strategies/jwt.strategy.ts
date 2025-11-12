import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { DatabaseService } from '../../../database/database.service';
import { authBlacklistedTokensTable, usersTable } from '../../../db/schema';
import { JwtPayload } from '../types/jwt-payload.interface';
import { eq } from 'drizzle-orm';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_ACCESS_SECRET'),
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload) {
    const token = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
    if (!token) {
      throw new UnauthorizedException('Missing authorization token');
    }

    const db = this.databaseService.connection;

    const [blacklisted] = await db
      .select()
      .from(authBlacklistedTokensTable)
      .where(eq(authBlacklistedTokensTable.token, token));

    if (blacklisted) {
      throw new UnauthorizedException('Token has been revoked');
    }

    const [user] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        orgId: usersTable.orgId,
        name: usersTable.name,
        status: usersTable.status,
        managerId: usersTable.managerId,
        employeeDepartmentId: usersTable.employeeDepartmentId,
      })
      .from(usersTable)
      .where(eq(usersTable.id, payload.sub));

    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    return {
      id: Number(user.id),
      orgId: Number(user.orgId),
      email: user.email,
      name: user.name,
      roles: payload.roles,
      permissions: payload.permissions,
      managerId:
        user.managerId !== null && user.managerId !== undefined
          ? Number(user.managerId)
          : payload.managerId ?? null,
      employeeDepartmentId:
        user.employeeDepartmentId !== null &&
        user.employeeDepartmentId !== undefined
          ? Number(user.employeeDepartmentId)
          : payload.employeeDepartmentId ?? null,
    };
  }
}
