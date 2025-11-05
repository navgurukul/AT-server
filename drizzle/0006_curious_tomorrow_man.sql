ALTER TABLE IF EXISTS "leave_requests" ADD COLUMN IF NOT EXISTS "half_day_segment" varchar(20);
ALTER TABLE IF EXISTS "navtrack"."leave_requests" ADD COLUMN IF NOT EXISTS "half_day_segment" varchar(20);
