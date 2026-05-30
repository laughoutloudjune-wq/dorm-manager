CREATE TABLE IF NOT EXISTS public.move_out_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  requested_move_out_date DATE NOT NULL,
  approved_move_out_date DATE,
  actual_move_out_date DATE,
  status TEXT NOT NULL DEFAULT 'requested',
  request_note TEXT,
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_move_out_requests_tenant_id
ON public.move_out_requests(tenant_id);

CREATE INDEX IF NOT EXISTS idx_move_out_requests_status
ON public.move_out_requests(status);

CREATE INDEX IF NOT EXISTS idx_move_out_requests_requested_date
ON public.move_out_requests(requested_move_out_date);
