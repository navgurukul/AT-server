ALTER TABLE "timesheet_entries"
ADD COLUMN IF NOT EXISTS "task_title" text;

ALTER TABLE "timesheet_entries"
ADD COLUMN IF NOT EXISTS "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;
