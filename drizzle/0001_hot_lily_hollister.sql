CREATE TABLE "backfill_counters" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"year" smallint NOT NULL,
	"month" smallint NOT NULL,
	"used" smallint DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "backfill_dates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"year" smallint NOT NULL,
	"month" smallint NOT NULL,
	"work_date" date NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leave_policies" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "leave_policies" RENAME COLUMN "updatedAt" TO "updated_at";--> statement-breakpoint
ALTER TABLE "leave_requests" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "leave_requests" RENAME COLUMN "updatedAt" TO "updated_at";--> statement-breakpoint
ALTER TABLE "notifications" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "notifications" RENAME COLUMN "updatedAt" TO "updated_at";--> statement-breakpoint
ALTER TABLE "orgs" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "orgs" RENAME COLUMN "updatedAt" TO "updated_at";--> statement-breakpoint
ALTER TABLE "payroll_windows" RENAME COLUMN "freezeState" TO "freeze_state";--> statement-breakpoint
ALTER TABLE "payroll_windows" RENAME COLUMN "createdAt" TO "updated_at";--> statement-breakpoint
ALTER TABLE "project_members" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "updatedAt" TO "updated_at";--> statement-breakpoint
ALTER TABLE "request_keys" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "timesheet_entries" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "timesheet_entries" RENAME COLUMN "updatedAt" TO "updated_at";--> statement-breakpoint
ALTER TABLE "timesheets" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "timesheets" RENAME COLUMN "updatedAt" TO "updated_at";--> statement-breakpoint
ALTER TABLE "user_roles" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "updatedAt" TO "updated_at";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "avatarUrl" TO "avatar_url";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "lastLoginAt" TO "last_login_at";--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_approver_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "cost_rates" DROP CONSTRAINT "cost_rates_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "event_outbox" DROP CONSTRAINT "event_outbox_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "leave_balances" DROP CONSTRAINT "leave_balances_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "leave_balances" DROP CONSTRAINT "leave_balances_leave_type_id_leave_types_id_fk";
--> statement-breakpoint
ALTER TABLE "leave_policies" DROP CONSTRAINT "leave_policies_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "leave_policies" DROP CONSTRAINT "leave_policies_leave_type_id_leave_types_id_fk";
--> statement-breakpoint
ALTER TABLE "leave_requests" DROP CONSTRAINT "leave_requests_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "leave_requests" DROP CONSTRAINT "leave_requests_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "leave_requests" DROP CONSTRAINT "leave_requests_leave_type_id_leave_types_id_fk";
--> statement-breakpoint
ALTER TABLE "leave_requests" DROP CONSTRAINT "leave_requests_decided_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "leave_types" DROP CONSTRAINT "leave_types_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "mv_leave_trends_monthly" DROP CONSTRAINT "mv_leave_trends_monthly_leave_type_id_leave_types_id_fk";
--> statement-breakpoint
ALTER TABLE "mv_project_costs_monthly" DROP CONSTRAINT "mv_project_costs_monthly_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "mv_user_productivity_daily" DROP CONSTRAINT "mv_user_productivity_daily_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "payroll_windows" DROP CONSTRAINT "payroll_windows_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "project_members" DROP CONSTRAINT "project_members_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "project_members" DROP CONSTRAINT "project_members_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "request_keys" DROP CONSTRAINT "request_keys_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_role_id_roles_id_fk";
--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_permission_id_permissions_id_fk";
--> statement-breakpoint
ALTER TABLE "timesheet_entries" DROP CONSTRAINT "timesheet_entries_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "timesheet_entries" DROP CONSTRAINT "timesheet_entries_timesheet_id_timesheets_id_fk";
--> statement-breakpoint
ALTER TABLE "timesheet_entries" DROP CONSTRAINT "timesheet_entries_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "timesheets" DROP CONSTRAINT "timesheets_locked_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "timesheets" DROP CONSTRAINT "timesheets_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "timesheets" DROP CONSTRAINT "timesheets_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_manager_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'pending'::text;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_type WHERE typname = 'job_status'
	) THEN
		CREATE TYPE "public"."job_status" AS ENUM ('pending', 'running', 'done', 'error');
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'pending'::"public"."job_status";--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "status" SET DATA TYPE "public"."job_status" USING "status"::"public"."job_status";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'active'::text;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_type WHERE typname = 'user_status'
	) THEN
		CREATE TYPE "public"."user_status" AS ENUM ('active', 'inactive', 'suspended');
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'active'::"public"."user_status";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "status" SET DATA TYPE "public"."user_status" USING "status"::"public"."user_status";--> statement-breakpoint
DROP INDEX "idx_auth_blacklisted_tokens_expiry";--> statement-breakpoint
DROP INDEX "idx_leave_balance_user_type";--> statement-breakpoint
DROP INDEX "idx_leave_requests_user_dates";--> statement-breakpoint
DROP INDEX "uq_payroll_window_org_month_year";--> statement-breakpoint
DROP INDEX "idx_request_keys_org_key";--> statement-breakpoint
DROP INDEX "idx_timesheet_entries_timesheet";--> statement-breakpoint
DROP INDEX "idx_timesheets_user_date";--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_type WHERE typname = 'decision'
	) THEN
		CREATE TYPE "public"."decision" AS ENUM ('pending', 'approved', 'rejected');
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "decision" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "decision" SET DATA TYPE "public"."decision" USING "decision"::text::"public"."decision";--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "decision" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "decision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "action" SET DATA TYPE varchar(120);--> statement-breakpoint
ALTER TABLE "cost_rates" ALTER COLUMN "effective_from" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "cost_rates" ALTER COLUMN "effective_to" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "cost_rates" ALTER COLUMN "currency" SET DATA TYPE char(3);--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "payload" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "payload" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "attempts" SET DATA TYPE smallint;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "attempts" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_balances" ALTER COLUMN "as_of_date" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "leave_policies" ALTER COLUMN "accrual_rule" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "leave_policies" ALTER COLUMN "carry_forward_rule" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "leave_policies" ALTER COLUMN "max_balance" SET DATA TYPE numeric(6, 2);--> statement-breakpoint
ALTER TABLE "leave_requests" ALTER COLUMN "start_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leave_requests" ALTER COLUMN "end_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leave_requests" ALTER COLUMN "hours" SET DATA TYPE numeric(6, 2);--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_type WHERE typname = 'leave_state'
	) THEN
		CREATE TYPE "public"."leave_state" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "leave_requests" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "leave_requests" ALTER COLUMN "state" SET DATA TYPE "public"."leave_state" USING "state"::text::"public"."leave_state";--> statement-breakpoint
ALTER TABLE "leave_requests" ALTER COLUMN "state" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "leave_types" ALTER COLUMN "code" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "leave_types" ALTER COLUMN "name" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "leave_types" ALTER COLUMN "requires_approval" SET NOT NULL;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_type WHERE typname = 'role_key'
	) THEN
		CREATE TYPE "public"."role_key" AS ENUM ('super_admin', 'admin', 'hr', 'manager', 'employee');
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "mv_user_productivity_daily" ALTER COLUMN "work_date" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "orgs" ALTER COLUMN "name" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "payroll_windows" ALTER COLUMN "month" SET DATA TYPE smallint;--> statement-breakpoint
ALTER TABLE "payroll_windows" ALTER COLUMN "year" SET DATA TYPE smallint;--> statement-breakpoint
ALTER TABLE "permissions" ALTER COLUMN "key" SET DATA TYPE varchar(128);--> statement-breakpoint
ALTER TABLE "permissions" ALTER COLUMN "description" SET DATA TYPE varchar(240);--> statement-breakpoint
ALTER TABLE "project_members" ALTER COLUMN "role" SET DATA TYPE varchar(80);--> statement-breakpoint
ALTER TABLE "project_members" ALTER COLUMN "role" SET DEFAULT 'contributor';--> statement-breakpoint
ALTER TABLE "project_members" ALTER COLUMN "allocation_pct" SET DEFAULT '100';--> statement-breakpoint
ALTER TABLE "project_members" ALTER COLUMN "start_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_members" ALTER COLUMN "end_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "name" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "code" SET DATA TYPE varchar(40);--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "start_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "end_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "budget_currency" SET DATA TYPE char(3);--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "budget_amount_minor" SET DATA TYPE numeric(18, 0);--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "key" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "name" SET DATA TYPE varchar(120);--> statement-breakpoint
ALTER TABLE "timesheet_entries" ALTER COLUMN "task_title" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ALTER COLUMN "hours_decimal" SET DATA TYPE numeric(5, 2);--> statement-breakpoint
ALTER TABLE "timesheet_entries" ALTER COLUMN "hours_decimal" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ALTER COLUMN "tags" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ALTER COLUMN "tags" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "work_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" SET DATA TYPE varchar(320);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "name" SET DATA TYPE varchar(160);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "rolePrimary" SET DATA TYPE "public"."role_key" USING "rolePrimary"::"public"."role_key";--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "subject_type" varchar(80) NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "actor_role" varchar(32);--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "subject_type" varchar(80) NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_blacklisted_tokens" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "event_type" varchar(80) NOT NULL;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "type" varchar(80) NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "run_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "locked_by" varchar(64);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "project_members" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "budget_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "backfill_counters" ADD CONSTRAINT "backfill_counters_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backfill_counters" ADD CONSTRAINT "backfill_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backfill_dates" ADD CONSTRAINT "backfill_dates_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backfill_dates" ADD CONSTRAINT "backfill_dates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_backfill_user_month" ON "backfill_counters" USING btree ("org_id","user_id","year","month");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_backfill_date" ON "backfill_dates" USING btree ("org_id","user_id","year","month","work_date");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_rates" ADD CONSTRAINT "cost_rates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD CONSTRAINT "leave_policies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD CONSTRAINT "leave_policies_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mv_leave_trends_monthly" ADD CONSTRAINT "mv_leave_trends_monthly_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mv_project_costs_monthly" ADD CONSTRAINT "mv_project_costs_monthly_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mv_user_productivity_daily" ADD CONSTRAINT "mv_user_productivity_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_windows" ADD CONSTRAINT "payroll_windows_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_keys" ADD CONSTRAINT "request_keys_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_timesheet_id_timesheets_id_fk" FOREIGN KEY ("timesheet_id") REFERENCES "public"."timesheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_window" ON "payroll_windows" USING btree ("org_id","year","month");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_request_key_org" ON "request_keys" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_user_date" ON "timesheets" USING btree ("org_id","user_id","work_date");--> statement-breakpoint
ALTER TABLE "approvals" DROP COLUMN "subjectType";--> statement-breakpoint
ALTER TABLE "approvals" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN "subjectType";--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "auth_blacklisted_tokens" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "cost_rates" DROP COLUMN "notes";--> statement-breakpoint
ALTER TABLE "cost_rates" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "event_outbox" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "event_outbox" DROP COLUMN "eventType";--> statement-breakpoint
ALTER TABLE "event_outbox" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "event_outbox" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "event_outbox" DROP COLUMN "error_text";--> statement-breakpoint
ALTER TABLE "event_outbox" DROP COLUMN "attempts";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "job_type";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "priority";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "run_after";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "last_run_at";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "max_attempts";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "error_text";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "updatedAt";--> statement-breakpoint
ALTER TABLE "leave_balances" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "leave_balances" DROP COLUMN "updatedAt";--> statement-breakpoint
ALTER TABLE "leave_types" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "leave_types" DROP COLUMN "max_per_request_hours";--> statement-breakpoint
ALTER TABLE "leave_types" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "payroll_windows" DROP COLUMN "updatedAt";--> statement-breakpoint
ALTER TABLE "permissions" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "role_permissions" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "roles" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "roles" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "timesheets" DROP COLUMN "locked_by_user_id";--> statement-breakpoint
