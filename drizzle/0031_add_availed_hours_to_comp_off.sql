-- Active: 1763708372787@@db-pg.cosodeda78lq.ap-south-1.rds.amazonaws.com@5432@dev
ALTER TABLE public.comp_off_credits ADD COLUMN "availed_hours" numeric(5, 2) NOT NULL DEFAULT 0;
