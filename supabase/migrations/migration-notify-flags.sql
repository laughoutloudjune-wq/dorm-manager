-- Add per-staff LINE notification preference flags.
-- Run once in Supabase SQL Editor (or psql).

ALTER TABLE public.line_meter_users
  ADD COLUMN IF NOT EXISTS notify_payment  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notify_move_out BOOLEAN NOT NULL DEFAULT FALSE;
