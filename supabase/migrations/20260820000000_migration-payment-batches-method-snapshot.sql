-- Payment batches + receiving-account snapshots
--
-- Two problems this fixes:
--
-- 1. `payment_batch_id` was a bare UUID stamped onto `invoice_payment_allocations`
--    and into each invoice's `payment_history` JSON, with no parent row. There was
--    nowhere to record what the tenant actually handed over (one transfer covering
--    several months), and idempotency had to be checked by scanning payment_history
--    JSON instead of by a unique index.
--
-- 2. Nothing recorded WHICH bank account received the money. Reports resolved it
--    from `tenants.custom_payment_method` at read time, so re-assigning a room's
--    account retroactively re-attributed every past month. The account is now
--    snapshotted onto the batch and onto every allocation row at the moment the
--    payment is applied, and never re-derived afterwards.
--
-- Additive only: no existing column or row is modified.

-- 1. The payment itself — one row per real transfer, regardless of how many
--    invoices it ends up settling.
CREATE TABLE IF NOT EXISTS public.payment_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
    -- The invoice the admin/tenant was looking at when they recorded the payment.
    -- Not necessarily the invoice the money was applied to.
    trigger_invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
    -- What arrived vs. what was placed against invoices. Equal today (allocation
    -- is capped at the chain's outstanding); they diverge once overpayment or
    -- tenant credit balances are supported.
    amount_received NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    amount_allocated NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    paid_at TIMESTAMPTZ NOT NULL,
    mode TEXT,
    source TEXT,
    slip_url TEXT,
    -- Receiving account, frozen at payment time. `payment_method_id` is a
    -- convenience pointer only: `payment_methods` rows are edited in place, so
    -- the JSONB copy is the authoritative record for reporting.
    payment_method_id UUID REFERENCES public.payment_methods(id) ON DELETE SET NULL,
    payment_method_snapshot JSONB,
    idempotency_key TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payment_batches IS
    'One row per money-in event. invoice_payment_allocations rows sharing a payment_batch_id are the split of this payment across invoices.';
COMMENT ON COLUMN public.payment_batches.payment_method_snapshot IS
    'Frozen copy of the receiving account ({type,methodId,label,bank_name,account_name,account_number,qr_url}). Never re-resolve this from tenants.custom_payment_method when reporting.';

CREATE INDEX IF NOT EXISTS idx_payment_batches_tenant_paid_at
    ON public.payment_batches(tenant_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_batches_paid_at
    ON public.payment_batches(paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_batches_method
    ON public.payment_batches(payment_method_id);

-- Idempotency is scoped to (trigger invoice, key) — the same scope the previous
-- payment_history scan used. A retried request now collides here instead of
-- double-charging.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_batches_trigger_idempotency
    ON public.payment_batches(trigger_invoice_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- 2. Carry the same account snapshot down onto each allocation row, so a
--    cash-basis report can group by receiving account without joining back to
--    the batch, and so an allocation stays attributable even if its batch row
--    is ever pruned.
--
--    No FK from invoice_payment_allocations.payment_batch_id to
--    payment_batches(id): allocation rows written before this migration have
--    batch ids with no parent row, and a FK would reject them.
ALTER TABLE public.invoice_payment_allocations
    ADD COLUMN IF NOT EXISTS payment_method_id UUID REFERENCES public.payment_methods(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS payment_method_snapshot JSONB;

COMMENT ON COLUMN public.invoice_payment_allocations.payment_method_snapshot IS
    'Receiving account frozen at payment time. NULL on rows written before this migration — report those as unknown rather than guessing from the tenant''s current account.';

CREATE INDEX IF NOT EXISTS idx_invoice_payment_allocations_invoice
    ON public.invoice_payment_allocations(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payment_allocations_paid_at
    ON public.invoice_payment_allocations(paid_at DESC);

-- 3. The account shown ON the invoice/receipt when it was issued — the account
--    the tenant was actually told to pay into. Distinct from the batch snapshot,
--    which is where money landed. Reserved here so the reporting work does not
--    need a second migration; not yet written by any code path.
ALTER TABLE public.invoices
    ADD COLUMN IF NOT EXISTS payment_method_snapshot JSONB;

COMMENT ON COLUMN public.invoices.payment_method_snapshot IS
    'Receiving account printed on this invoice at issue time. Reserved: not yet populated.';
