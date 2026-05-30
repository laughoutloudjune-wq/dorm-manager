-- Occupancy reconciliation + room movement journal support
-- Run in Supabase SQL Editor

BEGIN;

-- 1) Room movement journal
CREATE TABLE IF NOT EXISTS public.room_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('move_in', 'move_out')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_room_logs_room_id ON public.room_logs(room_id);
CREATE INDEX IF NOT EXISTS idx_room_logs_event_type ON public.room_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_room_logs_created_at ON public.room_logs(created_at DESC);

-- 2) Optional helper view for occupancy reconciliation / ghost room checks
CREATE OR REPLACE VIEW public.v_room_reconciliation AS
WITH active_tenant_rooms AS (
  SELECT DISTINCT t.room_id
  FROM public.tenants t
  WHERE t.status = 'active' AND t.room_id IS NOT NULL
)
SELECT
  r.id,
  r.room_number,
  r.status,
  CASE
    WHEN r.status IS NULL OR r.status NOT IN ('occupied', 'vacant', 'available', 'maintenance')
      THEN 'undefined/invalid room status'
    WHEN r.status = 'occupied' AND atr.room_id IS NULL
      THEN 'occupied but no active tenant'
    ELSE NULL
  END AS ghost_reason
FROM public.rooms r
LEFT JOIN active_tenant_rooms atr ON atr.room_id = r.id;

COMMIT;
