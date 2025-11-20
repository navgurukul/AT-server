-- Populate backfill_dates and backfill_counters from existing timesheets
WITH candidate_timesheets AS (
  SELECT
    org_id,
    user_id,
    EXTRACT(YEAR FROM work_date)::int AS year,
    EXTRACT(MONTH FROM work_date)::int AS month,
    work_date::date AS work_date
  FROM timesheets
  WHERE work_date < date_trunc('day', now())
    AND date_trunc('month', work_date) <= date_trunc('month', now())
),
dedup_dates AS (
  SELECT DISTINCT org_id, user_id, year, month, work_date
  FROM candidate_timesheets
)
INSERT INTO backfill_dates (org_id, user_id, year, month, work_date)
SELECT org_id, user_id, year, month, work_date
FROM dedup_dates
ON CONFLICT (org_id, user_id, year, month, work_date) DO NOTHING;

WITH candidate_timesheets AS (
  SELECT
    org_id,
    user_id,
    EXTRACT(YEAR FROM work_date)::int AS year,
    EXTRACT(MONTH FROM work_date)::int AS month,
    work_date::date AS work_date
  FROM timesheets
  WHERE work_date < date_trunc('day', now())
    AND date_trunc('month', work_date) <= date_trunc('month', now())
),
usage_per_month AS (
  SELECT
    org_id,
    user_id,
    year,
    month,
    COUNT(*)::smallint AS used
  FROM (
    SELECT DISTINCT org_id, user_id, year, month, work_date
    FROM candidate_timesheets
  ) t
  GROUP BY org_id, user_id, year, month
)
INSERT INTO backfill_counters (org_id, user_id, year, month, used, "limit", last_used_at)
SELECT org_id, user_id, year, month, used, 3, now()
FROM usage_per_month
ON CONFLICT (org_id, user_id, year, month)
DO UPDATE SET
  used = EXCLUDED.used,
  "limit" = COALESCE(backfill_counters."limit", 3),
  last_used_at = now();
