-- NOT FOR PRODUCTION. Applied only to the dummy test project dorm-test (rghxelkifdrpvabyxopb).
-- Objects the application code uses but no migration in this repo defines.
-- Everything here is INFERRED from code usage, verify against production.

-- INFERRED from code usage, verify against production: user_roles
-- (app/api/admin/user-roles/route.ts, lib/admin-api-auth.ts; role values per lib/permissions.ts)
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id UUID PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'viewer',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- INFERRED from code usage, verify against production: invoices.late_fee_billed_at
-- (app/api/admin/invoices/actions/route.ts, lib/invoice-generation.ts)
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS late_fee_billed_at TIMESTAMPTZ;

-- INFERRED from code usage, verify against production: storage buckets
INSERT INTO storage.buckets (id, name, public) VALUES
  ('payment_slips','payment_slips',true),
  ('payment-methods','payment-methods',true),
  ('tenant-docs','tenant-docs',true)
ON CONFLICT (id) DO NOTHING;
