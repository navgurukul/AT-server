-- Add Discord channel ID column to projects table
ALTER TABLE "public"."projects"
ADD COLUMN IF NOT EXISTS discord_channel_id varchar(200);
