-- Add status column to timesheet_entries table for soft delete functionality
-- Status can be: 'approved', 'rejected'
-- Default is 'approved'

ALTER TABLE timesheet_entries ADD COLUMN status VARCHAR(50) NOT NULL DEFAULT 'approved';

--> statement-breakpoint
