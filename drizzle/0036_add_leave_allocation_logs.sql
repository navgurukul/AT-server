CREATE TABLE IF NOT EXISTS public.leave_allocation_logs (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES public.users("id") ON DELETE CASCADE,
  "allocation_type" varchar(20) NOT NULL,
  "processed_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_allocation_log ON public.leave_allocation_logs ("user_id", "allocation_type");
