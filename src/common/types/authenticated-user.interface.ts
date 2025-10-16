export interface AuthenticatedUser {
  id: number;
  orgId: number;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
  managerId?: number | null;
}
