ALTER TABLE "leave_policies" ADD COLUMN "valid_employment_types" varchar(50)[] DEFAULT '{}'::varchar(50)[] NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD COLUMN "requires_alumni" boolean;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD COLUMN "trigger_event" varchar(20) DEFAULT 'DAY_1' NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD COLUMN "base_allocation_days" numeric(5, 2) DEFAULT 0.00 NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD COLUMN "is_prorated" boolean DEFAULT false NOT NULL;
