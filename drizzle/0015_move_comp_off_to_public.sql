DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'main'
      AND t.typname = 'comp_off_status'
  ) THEN
    EXECUTE 'ALTER TYPE "main"."comp_off_status" SET SCHEMA "public"';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'main'
      AND table_name = 'comp_off_credits'
  ) THEN
    EXECUTE 'ALTER TABLE "main"."comp_off_credits" SET SCHEMA "public"';
  END IF;
END $$;

CREATE TYPE IF NOT EXISTS "public"."comp_off_status" AS ENUM ('granted', 'expired', 'revoked');

CREATE TABLE IF NOT EXISTS "public"."comp_off_credits" (
  "id" serial PRIMARY KEY,
  "org_id" integer NOT NULL REFERENCES "public"."orgs"("id"),
  "user_id" integer NOT NULL REFERENCES "public"."users"("id"),
  "manager_id" integer NOT NULL REFERENCES "public"."users"("id"),
  "created_by" integer NOT NULL REFERENCES "public"."users"("id"),
  "timesheet_id" integer REFERENCES "public"."timesheets"("id"),
  "work_date" date NOT NULL,
  "duration_type" varchar(20) NOT NULL,
  "credited_hours" numeric(5, 2) NOT NULL,
  "timesheet_hours" numeric(5, 2),
  "status" "public"."comp_off_status" NOT NULL DEFAULT 'granted',
  "expires_at" timestamptz NOT NULL,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_comp_off_credits_user_status"
  ON "public"."comp_off_credits" ("user_id", "status");

CREATE INDEX IF NOT EXISTS "idx_comp_off_credits_org_status"
  ON "public"."comp_off_credits" ("org_id", "status");
