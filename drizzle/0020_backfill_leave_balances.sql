INSERT INTO leave_balances (
  user_id,
  leave_type_id,
  balance_hours,
  pending_hours,
  booked_hours,
  as_of_date,
  created_at,
  updated_at
)
SELECT
  u.id,
  lt.id,
  '80',
  '0',
  '0',
  CURRENT_DATE,
  NOW(),
  NOW()
FROM users u
INNER JOIN leave_types lt ON lt.org_id = u.org_id
WHERE lt.id IN (1, 2, 3, 4, 5)
  AND NOT EXISTS (
  SELECT 1
  FROM leave_balances lb
  WHERE lb.user_id = u.id
    AND lb.leave_type_id = lt.id
);
