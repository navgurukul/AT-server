-- Add allocated_hours to leave_balances
ALTER TABLE "public"."leave_balances"
  ADD COLUMN "allocated_hours" numeric(6, 2) NOT NULL DEFAULT '0';
