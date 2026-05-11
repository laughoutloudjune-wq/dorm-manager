-- Tenant takeover flow: room_takeover_requests + safety index
-- Run in Supabase SQL Editor

BEGIN;

CREATE TABLE IF NOT EXISTS public.room_takeover_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  requester_line_user_id TEXT NOT NULL,
  requester_full_name TEXT NOT NULL,
  requester_phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  current_active_tenant_id UUID,
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT room_takeover_requests_status_check
    CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_room_takeover_requests_room_status
  ON public.room_takeover_requests(room_id, status);

CREATE INDEX IF NOT EXISTS idx_room_takeover_requests_requester
  ON public.room_takeover_requests(requester_line_user_id);

-- Optional safety net: ensure there is only one active tenant per room.
-- If you already have duplicates, this statement will fail until the data is cleaned up.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_one_active_per_room
  ON public.tenants(room_id)
  WHERE status = 'active';

COMMIT;

