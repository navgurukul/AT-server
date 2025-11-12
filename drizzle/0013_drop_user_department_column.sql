SET search_path TO public;

ALTER TABLE "public"."users"
  DROP COLUMN IF EXISTS "department_id";
