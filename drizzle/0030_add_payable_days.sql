CREATE TABLE IF NOT EXISTS public.payable_days (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES public.users("id"),
  "expected_attendance" integer,
  "cycle" date NOT NULL,
  "total_hours" numeric(10, 1) NOT NULL DEFAULT 0.0,
  "total_working_days" numeric(10, 1) NOT NULL DEFAULT 0.0,
  "week_off" numeric(10, 1) NOT NULL DEFAULT 0.0,
  "total_payable_days" numeric(10, 1) NOT NULL DEFAULT 0.0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
