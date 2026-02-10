-- Add 'inactive' status to project_status enum
ALTER TYPE "public"."project_status" ADD VALUE IF NOT EXISTS 'inactive';
