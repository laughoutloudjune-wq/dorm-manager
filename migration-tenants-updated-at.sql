-- Add updated_at to tenants (used by cancel_move_out_process and future tenant updates)

ALTER TABLE public.tenants
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE public.tenants
SET updated_at = COALESCE(created_at, now())
WHERE updated_at IS NULL;
