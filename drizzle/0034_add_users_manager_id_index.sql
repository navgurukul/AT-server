-- Speeds up hierarchy audits and "reports of manager" lookups.
-- Production note: this uses CONCURRENTLY to avoid blocking writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS users_manager_id_idx
ON public.users (manager_id)
WHERE manager_id IS NOT NULL AND date_of_exit IS NULL;

