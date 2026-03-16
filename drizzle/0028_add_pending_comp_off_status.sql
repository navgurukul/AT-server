DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'comp_off_status'
      AND n.nspname = 'public'
      AND e.enumlabel = 'pending'
  ) THEN
    ALTER TYPE public.comp_off_status ADD VALUE 'pending' BEFORE 'granted';
  END IF;
END
$$;
