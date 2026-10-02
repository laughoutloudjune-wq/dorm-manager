-- Refund payouts: money actually sent to a tenant
--
-- ADDITIVE ONLY. Creates new objects; no existing table, column or row is touched.
-- NOT applied automatically: run it deliberately in the Supabase SQL editor.
-- Requires 20261002000200 (tenant_credits) for the refund_due_vs_paid view.
--
-- Rollback:
--   DROP VIEW IF EXISTS public.refund_due_vs_paid;
--   DROP TRIGGER IF EXISTS trg_refund_payouts_guard ON public.refund_payouts;
--   DROP TABLE IF EXISTS public.refund_payouts;
--   DROP FUNCTION IF EXISTS public.refund_payouts_guard();
--
-- Why: "refund due" (what we owe a tenant) and "refund paid" (what we actually
-- transferred) are different facts. A due amount is derived from tenant_credits;
-- a payout is a real transfer with a date, an account and evidence.
--
-- Append-only except one thing: a payout can be voided, once. The guard trigger
-- permits exactly one UPDATE per row, which sets voided_at (+ voided_by) and a
-- non-blank void_reason while every other column stays identical. DELETE is
-- always blocked. A wrongly voided payout is fixed by recording a new payout.
-- No FKs: audit-ish table.

CREATE TABLE IF NOT EXISTS public.refund_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    amount NUMERIC(12,2) NOT NULL CONSTRAINT refund_payouts_amount_positive CHECK (amount > 0),
    paid_at TIMESTAMPTZ NOT NULL,
    method TEXT,
    -- Account the money left from, frozen at payout time (same rule as payment_batches).
    payment_method_snapshot JSONB,
    recipient TEXT,
    reference TEXT,
    evidence_url TEXT,
    actor TEXT,
    idempotency_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    voided_at TIMESTAMPTZ,
    voided_by TEXT,
    void_reason TEXT,
    CONSTRAINT refund_payouts_idempotency_key_unique UNIQUE (idempotency_key),
    CONSTRAINT refund_payouts_void_consistent CHECK (
        (voided_at IS NULL AND void_reason IS NULL)
        OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND btrim(void_reason) <> '')
    )
);

CREATE INDEX IF NOT EXISTS idx_refund_payouts_tenant ON public.refund_payouts(tenant_id, paid_at);

CREATE OR REPLACE FUNCTION public.refund_payouts_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'refund_payouts is append-only (void instead)';
    END IF;
    IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'refund payout already voided';
    END IF;
    IF NEW.voided_at IS NULL THEN
        RAISE EXCEPTION 'refund_payouts is append-only; only a void is allowed';
    END IF;
    IF (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason')
       IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason') THEN
        RAISE EXCEPTION 'refund_payouts: only void columns may change';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_refund_payouts_guard ON public.refund_payouts;
CREATE TRIGGER trg_refund_payouts_guard
    BEFORE UPDATE OR DELETE ON public.refund_payouts
    FOR EACH ROW EXECUTE FUNCTION public.refund_payouts_guard();

ALTER TABLE public.refund_payouts ENABLE ROW LEVEL SECURITY;  -- service role only

-- Due = refundable credit we hold (deposit + unapplied), counted BEFORE any
-- 'refunded' ledger rows so payouts are the single source of truth for money
-- sent. Advance rent is not refundable by default and is excluded.
-- Paid = non-voided payouts. outstanding > 0: still owed; < 0: paid out beyond due.
CREATE OR REPLACE VIEW public.refund_due_vs_paid WITH (security_invoker = true) AS
WITH due AS (
    SELECT tenant_id, SUM(amount) AS refundable_credit
    FROM public.tenant_credits
    WHERE bucket IN ('deposit', 'unapplied') AND kind <> 'refunded'
    GROUP BY tenant_id
), paid AS (
    SELECT tenant_id, SUM(amount) AS refunded_paid
    FROM public.refund_payouts
    WHERE voided_at IS NULL
    GROUP BY tenant_id
)
SELECT
    COALESCE(d.tenant_id, p.tenant_id) AS tenant_id,
    COALESCE(d.refundable_credit, 0) AS refund_due,
    COALESCE(p.refunded_paid, 0) AS refund_paid,
    COALESCE(d.refundable_credit, 0) - COALESCE(p.refunded_paid, 0) AS refund_outstanding
FROM due d
FULL OUTER JOIN paid p ON p.tenant_id = d.tenant_id;
