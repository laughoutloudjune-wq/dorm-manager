-- Meter staff registry: status + notes (replaces manual LINE_METER_USER_IDS env workflow)
-- Run in Supabase SQL Editor

BEGIN;

ALTER TABLE public.line_meter_users
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS staff_note TEXT,
  ADD COLUMN IF NOT EXISTS registered_via TEXT;

ALTER TABLE public.line_meter_users
  DROP CONSTRAINT IF EXISTS line_meter_users_status_check;

ALTER TABLE public.line_meter_users
  ADD CONSTRAINT line_meter_users_status_check
  CHECK (status IN ('active', 'inactive'));

UPDATE public.line_meter_users
SET status = 'active'
WHERE status IS NULL OR status = '';

CREATE INDEX IF NOT EXISTS idx_line_meter_users_status
  ON public.line_meter_users(status);

COMMIT;
