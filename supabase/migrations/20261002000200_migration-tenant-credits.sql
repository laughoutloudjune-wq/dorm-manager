-- Tenant credits: append-only ledger of money held for a tenant
--
-- ADDITIVE ONLY. Creates new objects; no existing table, column or row is touched.
-- NOT applied automatically: run it deliberately in the Supabase SQL editor.
--
-- Rollback:
--   DROP VIEW IF EXISTS public.refund_due_vs_paid;   -- only if 20261002000300 was applied
--   DROP VIEW IF EXISTS public.tenant_credit_balances;
--   DROP TRIGGER IF EXISTS trg_tenant_credits_append_only ON public.tenant_credits;
--   DROP TABLE IF EXISTS public.tenant_credits;
--   DROP FUNCTION IF EXISTS public.tenant_credits_block_mutation();
--
-- Why: deposits, advance rent and overpayments were scattered across tenant
-- columns and payment sources ('credit', 'abandon_room'). One ledger says what
-- we hold for a tenant and why. Corrections are NEW rows (kind 'reversal'),
-- never edits.
--
-- Sign convention: `amount` is signed and never zero. Money in = positive
-- (deposit_received, advance_rent_received, overpayment). Money leaving the
-- held balance = negative (applied_to_invoice, forfeited, refunded). A reversal
-- carries the opposite sign of what it undoes.
--
-- `bucket` says which pot the row moves, so balances stay unambiguous even for
-- rows (applied_to_invoice, forfeited, refunded, reversal) that could draw on
-- more than one. The "in" kinds are pinned to their natural bucket.
-- No FKs: audit-ish table, survives deletion of what it describes.

CREATE TABLE IF NOT EXISTS public.tenant_credits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    kind TEXT NOT NULL
        CONSTRAINT tenant_credits_kind_check
        CHECK (kind IN ('deposit_received', 'advance_rent_received', 'overpayment',
                        'applied_to_invoice', 'forfeited', 'refunded', 'reversal')),
    bucket TEXT NOT NULL
        CONSTRAINT tenant_credits_bucket_check
        CHECK (bucket IN ('deposit', 'advance', 'unapplied')),
    amount NUMERIC(12,2) NOT NULL CONSTRAINT tenant_credits_amount_nonzero CHECK (amount <> 0),
    invoice_id UUID,
    payment_batch_id UUID,
    reason TEXT,
    actor TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tenant_credits_in_kind_bucket CHECK (
        (kind <> 'deposit_received' OR (bucket = 'deposit' AND amount > 0)) AND
        (kind <> 'advance_rent_received' OR (bucket = 'advance' AND amount > 0)) AND
        (kind <> 'overpayment' OR (bucket = 'unapplied' AND amount > 0)) AND
        (kind NOT IN ('applied_to_invoice', 'forfeited', 'refunded') OR amount < 0)
    ),
    -- Anything that is not a plain receipt must explain itself.
    -- Whitespace-only (spaces, tabs, newlines) counts as blank.
    CONSTRAINT tenant_credits_reason_check CHECK (
        kind IN ('deposit_received', 'advance_rent_received', 'overpayment', 'applied_to_invoice')
        OR (reason IS NOT NULL AND reason ~ '[^[:space:]]')
    )
);

-- Re-assert the reason rule on databases where an earlier draft of this table
-- (btrim, spaces only) already exists. Idempotent.
ALTER TABLE public.tenant_credits DROP CONSTRAINT IF EXISTS tenant_credits_reason_check;
ALTER TABLE public.tenant_credits ADD CONSTRAINT tenant_credits_reason_check CHECK (
    kind IN ('deposit_received', 'advance_rent_received', 'overpayment', 'applied_to_invoice')
    OR (reason IS NOT NULL AND reason ~ '[^[:space:]]')
);

-- A 'reversal' row may point at the exact row it undoes (void_payment_batch
-- always sets it). Each row can be reversed at most once.
ALTER TABLE public.tenant_credits ADD COLUMN IF NOT EXISTS reverses_credit_id UUID;
ALTER TABLE public.tenant_credits DROP CONSTRAINT IF EXISTS tenant_credits_reverses_kind_check;
ALTER TABLE public.tenant_credits ADD CONSTRAINT tenant_credits_reverses_kind_check
    CHECK (reverses_credit_id IS NULL OR kind = 'reversal');
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_credits_single_reversal
    ON public.tenant_credits(reverses_credit_id)
    WHERE reverses_credit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_credits_tenant ON public.tenant_credits(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tenant_credits_invoice ON public.tenant_credits(invoice_id);
CREATE INDEX IF NOT EXISTS idx_tenant_credits_batch ON public.tenant_credits(payment_batch_id);

CREATE OR REPLACE FUNCTION public.tenant_credits_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'tenant_credits is append-only (post a reversal instead)';
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_credits_append_only ON public.tenant_credits;
CREATE TRIGGER trg_tenant_credits_append_only
    BEFORE UPDATE OR DELETE ON public.tenant_credits
    FOR EACH ROW EXECUTE FUNCTION public.tenant_credits_block_mutation();

ALTER TABLE public.tenant_credits ENABLE ROW LEVEL SECURITY;  -- service role only

CREATE OR REPLACE VIEW public.tenant_credit_balances WITH (security_invoker = true) AS
SELECT
    tenant_id,
    COALESCE(SUM(amount) FILTER (WHERE bucket = 'deposit'), 0)   AS deposit_held,
    COALESCE(SUM(amount) FILTER (WHERE bucket = 'advance'), 0)   AS advance_held,
    COALESCE(SUM(amount) FILTER (WHERE bucket = 'unapplied'), 0) AS unapplied_credit
FROM public.tenant_credits
GROUP BY tenant_id;
