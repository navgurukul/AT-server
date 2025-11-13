CREATE TYPE "public"."comp_off_status" AS ENUM('granted', 'expired', 'revoked');--> statement-breakpoint
CREATE TABLE "comp_off_credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"manager_id" integer NOT NULL,
	"created_by" integer NOT NULL,
	"timesheet_id" integer,
	"work_date" date NOT NULL,
	"duration_type" varchar(20) NOT NULL,
	"credited_hours" numeric(5, 2) NOT NULL,
	"timesheet_hours" numeric(5, 2),
	"status" "comp_off_status" DEFAULT 'granted' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "employee_departments" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL,
	"code" varchar(50),
	"description" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "employee_departments_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_department_id_departments_id_fk";
--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "task_title" text;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "employee_department_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "work_location_type" varchar(120);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "date_of_joining" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "employment_type" varchar(160);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "employment_status" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "date_of_exit" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "slack_id" varchar(160);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "alumni_status" varchar(120);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "gender" varchar(32);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "discord_id" varchar(160);--> statement-breakpoint
ALTER TABLE "comp_off_credits" ADD CONSTRAINT "comp_off_credits_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_off_credits" ADD CONSTRAINT "comp_off_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_off_credits" ADD CONSTRAINT "comp_off_credits_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_off_credits" ADD CONSTRAINT "comp_off_credits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_off_credits" ADD CONSTRAINT "comp_off_credits_timesheet_id_timesheets_id_fk" FOREIGN KEY ("timesheet_id") REFERENCES "public"."timesheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_employee_department_id_employee_departments_id_fk" FOREIGN KEY ("employee_department_id") REFERENCES "public"."employee_departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "department_id";