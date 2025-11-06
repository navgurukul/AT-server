ALTER TABLE "leave_balances" ADD COLUMN "pending_hours" numeric(6, 2) DEFAULT 0 NOT NULL;
ALTER TABLE "leave_balances" ADD COLUMN "booked_hours" numeric(6, 2) DEFAULT 0 NOT NULL;

UPDATE "leave_balances"
SET "balance_hours" = ROUND(("balance_hours" * 8)::numeric, 2)
WHERE "balance_hours" IS NOT NULL;
