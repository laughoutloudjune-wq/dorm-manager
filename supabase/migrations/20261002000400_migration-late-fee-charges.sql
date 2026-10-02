-- Late-fee charges + versioned late-fee policies
--
-- ADDITIVE ONLY. Creates new objects; no existing table, column or row is touched.
-- NOT applied automatically: run it deliberately in the Supabase SQL editor.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_late_fee_charges_append_only ON public.late_fee_charges;
--   DROP TRIGGER IF EXISTS trg_late_fee_policies_append_only ON public.late_fee_policies;
--   DROP TABLE IF EXISTS public.late_fee_charges;
--   DROP TABLE IF EXISTS public.late_fee_policies;
--   DROP FUNCTION IF EXISTS public.late_fee_block_mutation();
--
-- Why: a posted late fee is a distinct, explainable entry (which invoice it came
-- from, which days it covers, the balance it was computed on, the exact formula
-- and policy version) instead of a number folded into invoice columns. The unique
-- key (source_invoice_id, covered_from, covered_to, policy_version) makes posting
-- the same fee twice impossible. Charges and policies are append-only: a policy
-- change is a NEW version; a wrong charge is answered by an adjustment (waiver).
-- No FKs: audit-ish tables.

CREATE TABLE IF NOT EXISTS public.late_fee_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version INTEGER NOT NULL CONSTRAINT late_fee_policies_version_unique UNIQUE,
    effective_from DATE NOT NULL,
    grace_days INTEGER NOT NULL DEFAULT 0 CONSTRAINT late_fee_policies_grace_check CHECK (grace_days >= 0),
    rate_kind TEXT NOT NULL
        CONSTRAINT late_fee_policies_rate_kind_check
        CHECK (rate_kind IN ('flat_per_day', 'percent_per_day', 'flat_once', 'percent_once')),
    rate_value NUMERIC(12,4) NOT NULL CONSTRAINT late_fee_policies_rate_value_check CHECK (rate_value >= 0),
    -- Whether a partial payment shrinks the balance the fee is computed on.
    partial_payments_reduce_base BOOLEAN NOT NULL DEFAULT true,
    cap NUMERIC(12,2) CONSTRAINT late_fee_policies_cap_check CHECK (cap IS NULL OR cap >= 0),
    rounding TEXT NOT NULL DEFAULT 'floor'
        CONSTRAINT late_fee_policies_rounding_check CHECK (rounding IN ('floor', 'round', 'ceil')),
    compounding BOOLEAN NOT NULL DEFAULT false,
    -- Automation may only post fees under a policy that explicitly opts in.
    auto_post BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.late_fee_charges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_invoice_id UUID NOT NULL,
    -- The invoice the fee is billed on (the next invoice, per CLAUDE.md).
    target_invoice_id UUID,
    covered_from DATE NOT NULL,
    covered_to DATE NOT NULL,
    eligible_balance NUMERIC(12,2) NOT NULL CONSTRAINT late_fee_charges_balance_check CHECK (eligible_balance >= 0),
    rate_kind TEXT NOT NULL,
    rate_value NUMERIC(12,4) NOT NULL,
    -- Human-readable working, e.g. '4,490 x 1% x 12 days = 538'.
    formula TEXT NOT NULL CONSTRAINT late_fee_charges_formula_check CHECK (formula ~ '[^[:space:]]'),
    policy_version INTEGER NOT NULL,
    amount NUMERIC(12,2) NOT NULL CONSTRAINT late_fee_charges_amount_check CHECK (amount >= 0),
    -- A user id, or 'automation:<name>'.
    posted_by TEXT NOT NULL CONSTRAINT late_fee_charges_posted_by_check CHECK (posted_by ~ '[^[:space:]]'),
    posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT late_fee_charges_period_check CHECK (covered_to >= covered_from),
    CONSTRAINT uq_late_fee_charge_period
        UNIQUE (source_invoice_id, covered_from, covered_to, policy_version)
);

-- Re-assert on databases where an earlier draft (btrim, spaces only) exists.
-- Whitespace-only (spaces, tabs, newlines) counts as blank. Idempotent.
ALTER TABLE public.late_fee_charges DROP CONSTRAINT IF EXISTS late_fee_charges_formula_check;
ALTER TABLE public.late_fee_charges ADD CONSTRAINT late_fee_charges_formula_check CHECK (formula ~ '[^[:space:]]');
ALTER TABLE public.late_fee_charges DROP CONSTRAINT IF EXISTS late_fee_charges_posted_by_check;
ALTER TABLE public.late_fee_charges ADD CONSTRAINT late_fee_charges_posted_by_check CHECK (posted_by ~ '[^[:space:]]');

CREATE INDEX IF NOT EXISTS idx_late_fee_charges_source ON public.late_fee_charges(source_invoice_id);
CREATE INDEX IF NOT EXISTS idx_late_fee_charges_target ON public.late_fee_charges(target_invoice_id);

CREATE OR REPLACE FUNCTION public.late_fee_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_late_fee_charges_append_only ON public.late_fee_charges;
CREATE TRIGGER trg_late_fee_charges_append_only
    BEFORE UPDATE OR DELETE ON public.late_fee_charges
    FOR EACH ROW EXECUTE FUNCTION public.late_fee_block_mutation();

DROP TRIGGER IF EXISTS trg_late_fee_policies_append_only ON public.late_fee_policies;
CREATE TRIGGER trg_late_fee_policies_append_only
    BEFORE UPDATE OR DELETE ON public.late_fee_policies
    FOR EACH ROW EXECUTE FUNCTION public.late_fee_block_mutation();

ALTER TABLE public.late_fee_charges ENABLE ROW LEVEL SECURITY;   -- service role only
ALTER TABLE public.late_fee_policies ENABLE ROW LEVEL SECURITY;  -- service role only
