export interface AuthenticatedUser {
  id: number;
  orgId: number;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
  managerId?: number | null;
  employeeDepartmentId?: number | null;
  employeeDepartment?: {
    id: number;
    name: string;
    code: string | null;
    description: string | null;
  } | null;
}
