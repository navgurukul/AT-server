ALTER TABLE "approvals" ADD COLUMN "subjectType" varchar(80);--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "createdAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "subjectType" varchar(80);--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "createdAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_blacklisted_tokens" ADD COLUMN "createdAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cost_rates" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "cost_rates" ADD COLUMN "createdAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "org_id" integer;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "eventType" varchar(80);--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "createdAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "error_text" text;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "attempts" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "org_id" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "job_type" varchar(80);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "priority" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "run_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "max_attempts" smallint;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "error_text" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "createdAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "updatedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN "createdAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN "updatedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leave_types" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "leave_types" ADD COLUMN "max_per_request_hours" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "leave_types" ADD COLUMN "createdAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payroll_windows" ADD COLUMN "updatedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "permissions" ADD COLUMN "createdAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "createdAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "createdAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "locked_by_user_id" integer;