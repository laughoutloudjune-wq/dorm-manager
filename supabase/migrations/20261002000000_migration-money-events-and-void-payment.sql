-- Money audit log + append-only payment void/reversal
--
-- Additive only. No existing row is modified by this migration, and it is NOT
-- applied automatically: run it deliberately in the Supabase SQL editor.
--
-- 1. money_events: append-only log of every money-affecting admin action
--    (action, actor, before/after, reason). Written by lib/money-events.ts.
-- 2. payment_batches gains voided_at/voided_by/void_reason, and
--    invoice_payment_allocations gains reverses_allocation_id, so a void is
--    recorded as NEW negative allocation rows pointing at the originals.
--    Anything that sums allocations nets to zero without code changes, and the
--    original receipt and allocations stay visible next to their reversal.
-- 3. void_payment_batch(): does the whole void in one transaction, with the
--    batch row locked so two admins (or a double click) cannot void it twice.

CREATE TABLE IF NOT EXISTS public.money_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action TEXT NOT NULL,
    actor_user_id TEXT,
    tenant_id UUID,
    invoice_id UUID,
    payment_batch_id UUID,
    room_id UUID,
    before JSONB,
    after JSONB,
    reason TEXT,
    source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deliberately no FKs: the log must survive deletion of the thing it describes.
CREATE INDEX IF NOT EXISTS idx_money_events_created_at ON public.money_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_money_events_invoice ON public.money_events(invoice_id);
CREATE INDEX IF NOT EXISTS idx_money_events_batch ON public.money_events(payment_batch_id);
CREATE INDEX IF NOT EXISTS idx_money_events_tenant ON public.money_events(tenant_id);

CREATE OR REPLACE FUNCTION public.money_events_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'money_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_money_events_append_only ON public.money_events;
CREATE TRIGGER trg_money_events_append_only
    BEFORE UPDATE OR DELETE ON public.money_events
    FOR EACH ROW EXECUTE FUNCTION public.money_events_block_mutation();

ALTER TABLE public.money_events ENABLE ROW LEVEL SECURITY;  -- service role only

ALTER TABLE public.payment_batches
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS voided_by TEXT,
    ADD COLUMN IF NOT EXISTS void_reason TEXT;

ALTER TABLE public.invoice_payment_allocations
    ADD COLUMN IF NOT EXISTS reverses_allocation_id UUID,
    ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reversal_reason TEXT;

-- An allocation can be reversed at most once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_allocation_single_reversal
    ON public.invoice_payment_allocations(reverses_allocation_id)
    WHERE reverses_allocation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.void_payment_batch(
    p_batch_id UUID,
    p_reason TEXT,
    p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_batch public.payment_batches%ROWTYPE;
    v_alloc public.invoice_payment_allocations%ROWTYPE;
    v_inv public.invoices%ROWTYPE;
    v_new_paid NUMERIC;
    v_new_status public.invoice_status;
    v_touched JSONB := '[]'::jsonb;
    v_count INT := 0;
BEGIN
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'A reason is required to void a payment';
    END IF;

    SELECT * INTO v_batch FROM public.payment_batches WHERE id = p_batch_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment batch not found';
    END IF;
    IF v_batch.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'Payment batch already voided';
    END IF;

    FOR v_alloc IN
        SELECT * FROM public.invoice_payment_allocations
        WHERE payment_batch_id = p_batch_id
          AND reverses_allocation_id IS NULL
          AND amount > 0
        ORDER BY created_at
    LOOP
        INSERT INTO public.invoice_payment_allocations (
            payment_batch_id, trigger_invoice_id, invoice_id, amount, paid_at,
            slip_url, source, payment_method_id, payment_method_snapshot,
            reverses_allocation_id, reversed_at, reversal_reason
        ) VALUES (
            v_alloc.payment_batch_id, v_alloc.trigger_invoice_id, v_alloc.invoice_id,
            -v_alloc.amount, v_alloc.paid_at,
            v_alloc.slip_url, 'void', v_alloc.payment_method_id, v_alloc.payment_method_snapshot,
            v_alloc.id, now(), p_reason
        );

        SELECT * INTO v_inv FROM public.invoices WHERE id = v_alloc.invoice_id FOR UPDATE;
        v_new_paid := COALESCE(v_inv.paid_amount, 0) - v_alloc.amount;
        v_new_status := v_inv.status;
        -- A void must not leave an invoice labelled paid with money missing.
        IF v_inv.status IN ('paid', 'partial') AND v_new_paid < COALESCE(v_inv.total_amount, 0) THEN
            v_new_status := CASE WHEN v_new_paid > 0 THEN 'partial'::public.invoice_status ELSE 'pending'::public.invoice_status END;
        END IF;

        UPDATE public.invoices
        SET paid_amount = v_new_paid,
            status = v_new_status,
            payment_history = COALESCE(payment_history, '[]'::jsonb) || jsonb_build_array(
                jsonb_build_object(
                    'type', 'void',
                    'payment_batch_id', p_batch_id,
                    'amount', -v_alloc.amount,
                    'reason', p_reason,
                    'voided_at', now()
                )
            )
        WHERE id = v_alloc.invoice_id;

        INSERT INTO public.money_events (
            action, actor_user_id, tenant_id, invoice_id, payment_batch_id,
            before, after, reason, source
        ) VALUES (
            'payment.void', p_actor, v_batch.tenant_id, v_alloc.invoice_id, p_batch_id,
            jsonb_build_object('paid_amount', v_inv.paid_amount, 'status', v_inv.status, 'allocation_amount', v_alloc.amount),
            jsonb_build_object('paid_amount', v_new_paid, 'status', v_new_status),
            p_reason, 'void_payment_batch'
        );

        v_touched := v_touched || to_jsonb(v_alloc.invoice_id);
        v_count := v_count + 1;
    END LOOP;

    UPDATE public.payment_batches
    SET voided_at = now(), voided_by = p_actor, void_reason = p_reason
    WHERE id = p_batch_id;

    RETURN jsonb_build_object('voided', true, 'reversed_allocations', v_count, 'touched_invoice_ids', v_touched);
END;
$$;

COMMENT ON FUNCTION public.void_payment_batch IS
    'Atomically reverses a receipt: appends negative allocation rows, lowers invoices.paid_amount, logs money_events. Never deletes the receipt or its allocations.';
