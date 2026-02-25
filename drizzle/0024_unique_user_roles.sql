-- Migration: Make user_id unique in user_roles table
-- This ensures each user can have only one role

-- First, handle any duplicate user_ids by keeping only the most recent role assignment
WITH ranked_roles AS (
  SELECT 
    user_id,
    role_id,
    created_at,
    ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) as rn
  FROM user_roles
)
DELETE FROM user_roles
WHERE (user_id, role_id) IN (
  SELECT user_id, role_id 
  FROM ranked_roles 
  WHERE rn > 1
);

--> statement-breakpoint

-- Drop the existing composite primary key
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_user_id_role_id_pk";

--> statement-breakpoint

-- Add user_id as the primary key (enforcing uniqueness)
ALTER TABLE "user_roles" ADD PRIMARY KEY ("user_id");