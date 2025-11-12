SET search_path TO public;

CREATE TABLE IF NOT EXISTS "public"."employee_departments" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL,
	"code" varchar(50),
	"description" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "employee_departments_name_unique" ON "public"."employee_departments" ("name");

ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "employee_department_id" integer;
ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "work_location_type" varchar(120);
ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "date_of_joining" date;
ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "employment_type" varchar(160);
ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "employment_status" varchar(64) DEFAULT 'active';
ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "date_of_exit" date;
ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "slack_id" varchar(160);
ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "alumni_status" varchar(120);
ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "gender" varchar(32);
ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "discord_id" varchar(160);

ALTER TABLE "public"."users" ADD CONSTRAINT "users_employee_department_id_employee_departments_id_fk"
  FOREIGN KEY ("employee_department_id") REFERENCES "public"."employee_departments"("id")
  ON DELETE set null ON UPDATE no action;
