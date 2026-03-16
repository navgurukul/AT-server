-- Create off_day_work_request_status enum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'off_day_work_request_status'
      AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.off_day_work_request_status AS ENUM ('pending', 'approved', 'cancelled');
  END IF;
END
$$;

-- Create off_day_work_requests table
CREATE TABLE IF NOT EXISTS public.off_day_work_requests (
  "id" serial PRIMARY KEY,
  "org_id" integer NOT NULL REFERENCES public.orgs("id"),
  "user_id" integer NOT NULL REFERENCES public.users("id"),
  "manager_id" integer NOT NULL REFERENCES public.users("id"),
  "created_by" integer NOT NULL REFERENCES public.users("id"),
  "work_date" date NOT NULL,
  "duration_type" varchar(20) NOT NULL,
  "status" public.off_day_work_request_status NOT NULL DEFAULT 'approved',
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_off_day_work_requests_user_status
  ON public.off_day_work_requests ("user_id", "status");

CREATE INDEX IF NOT EXISTS idx_off_day_work_requests_org_date
  ON public.off_day_work_requests ("org_id", "work_date");

CREATE INDEX IF NOT EXISTS idx_off_day_work_requests_user_date
  ON public.off_day_work_requests ("user_id", "work_date", "status");
