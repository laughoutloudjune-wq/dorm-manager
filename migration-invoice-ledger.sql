ALTER TABLE public.invoices
ADD COLUMN IF NOT EXISTS carry_forward_amount NUMERIC(10, 2) DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.invoice_carry_forwards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  target_invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoice_carry_forwards_source_unique UNIQUE (source_invoice_id)
);

CREATE TABLE IF NOT EXISTS public.invoice_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_batch_id UUID NOT NULL,
  trigger_invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  paid_at TIMESTAMPTZ NOT NULL,
  slip_url TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoice_arrears_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  target_invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  snapshot_as_of DATE NOT NULL,
  principal_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  late_fee_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  days_overdue INT NOT NULL DEFAULT 0,
  daily_rate NUMERIC(10, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_carry_forwards_target
ON public.invoice_carry_forwards(target_invoice_id);

CREATE INDEX IF NOT EXISTS idx_invoice_payment_allocations_batch
ON public.invoice_payment_allocations(payment_batch_id);

CREATE INDEX IF NOT EXISTS idx_invoice_arrears_snapshots_target
ON public.invoice_arrears_snapshots(target_invoice_id);
