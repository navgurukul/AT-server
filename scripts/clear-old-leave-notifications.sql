-- Delete old pending leave notifications
-- Run this before creating a new leave request to test the new format

DELETE FROM notifications
WHERE template = 'leave_request'
  AND state = 'pending';

-- Check how many were deleted
SELECT 'Deleted pending leave notifications';
