ALTER TABLE backfill_counters
  ADD COLUMN IF NOT EXISTS "limit" smallint NOT NULL DEFAULT 3;

UPDATE backfill_counters
  SET "limit" = 3
  WHERE "limit" IS NULL;
