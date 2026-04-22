
import { ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../types/authenticated-user.interface';

export const checkAdminSelfAction = (
  currentUser: AuthenticatedUser,
  targetUserId: string,
) => {
  const { id: currentUserId, roles } = currentUser;
  const isAdmin = roles.includes('admin') || roles.includes('super_admin');

  if (isAdmin && currentUserId.toString() === targetUserId) {
    throw new ForbiddenException(
      'Admins/Super Admins are not allowed to perform this action on their own account.',
    );
  }
};
