ALTER TABLE public.projects
ADD COLUMN IF NOT EXISTS slack_channel_id varchar(200);
