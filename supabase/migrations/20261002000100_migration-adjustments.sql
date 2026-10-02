-- Adjustments: append-only ledger of discounts, waivers, corrections, write-offs
--
-- ADDITIVE ONLY. Creates new objects; no existing table, column or row is touched.
-- NOT applied automatically: run it deliberately in the Supabase SQL editor.
--
-- Rollback (nothing else depends on these objects):
--   DROP TRIGGER IF EXISTS trg_adjustments_append_only ON public.adjustments;
--   DROP TABLE IF EXISTS public.adjustments;
--   DROP FUNCTION IF EXISTS public.adjustments_block_mutation();
--
-- Why: money-changing decisions that are not payments (a discount, a waived fee,
-- a correction, a write-off) used to be silent edits to invoice columns. Each is
-- now a row with a mandatory reason and an actor. A mistake is undone by a NEW
-- row of type 'reversal' pointing at the original, never by editing it.
--
-- Sign convention: `amount` is signed and never zero. Positive reduces what the
-- tenant owes (discount, waiver, write_off); a correction may be either sign; a
-- reversal carries the opposite sign of the row it reverses.
-- Like money_events: no FKs, so the log survives deletion of what it describes.

CREATE TABLE IF NOT EXISTS public.adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL
        CONSTRAINT adjustments_type_check
        CHECK (type IN ('discount', 'waiver', 'correction', 'write_off', 'reversal')),
    amount NUMERIC(12,2) NOT NULL CONSTRAINT adjustments_amount_nonzero CHECK (amount <> 0),
    invoice_id UUID,
    tenant_id UUID,
    -- Whitespace-only (spaces, tabs, newlines) counts as blank.
    reason TEXT NOT NULL CONSTRAINT adjustments_reason_not_blank CHECK (reason ~ '[^[:space:]]'),
    actor TEXT,
    source TEXT,
    -- Set only on type = 'reversal'; an adjustment can be reversed at most once.
    reverses_adjustment_id UUID,
    -- Caller-supplied idempotency key: a retried request replays instead of duplicating.
    reference_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT adjustments_reversal_link_check
        CHECK ((type = 'reversal') = (reverses_adjustment_id IS NOT NULL))
);

-- Re-assert on databases where an earlier draft (btrim, spaces only) exists. Idempotent.
ALTER TABLE public.adjustments DROP CONSTRAINT IF EXISTS adjustments_reason_not_blank;
ALTER TABLE public.adjustments ADD CONSTRAINT adjustments_reason_not_blank CHECK (reason ~ '[^[:space:]]');

CREATE UNIQUE INDEX IF NOT EXISTS uq_adjustments_single_reversal
    ON public.adjustments(reverses_adjustment_id)
    WHERE reverses_adjustment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_adjustments_reference_key
    ON public.adjustments(reference_key)
    WHERE reference_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_adjustments_invoice ON public.adjustments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_adjustments_tenant ON public.adjustments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_adjustments_created_at ON public.adjustments(created_at DESC);

CREATE OR REPLACE FUNCTION public.adjustments_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'adjustments is append-only (post a reversal instead)';
END;
$$;

DROP TRIGGER IF EXISTS trg_adjustments_append_only ON public.adjustments;
CREATE TRIGGER trg_adjustments_append_only
    BEFORE UPDATE OR DELETE ON public.adjustments
    FOR EACH ROW EXECUTE FUNCTION public.adjustments_block_mutation();

ALTER TABLE public.adjustments ENABLE ROW LEVEL SECURITY;  -- service role only
