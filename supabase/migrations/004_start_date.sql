-- Add start_date column to tasks
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS start_date timestamptz;
