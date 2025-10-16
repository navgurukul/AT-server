export interface JwtPayload {
  sub: number;
  email: string;
  orgId: number;
  roles: string[];
  permissions: string[];
  managerId?: number | null;
  iat?: number;
  exp?: number;
}
