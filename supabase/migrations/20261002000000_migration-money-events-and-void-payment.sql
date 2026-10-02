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

-- A voided batch must say why. Whitespace-only (incl. tab/newline) is blank.
ALTER TABLE public.payment_batches DROP CONSTRAINT IF EXISTS payment_batches_void_reason_check;
ALTER TABLE public.payment_batches ADD CONSTRAINT payment_batches_void_reason_check
    CHECK (voided_at IS NULL OR (void_reason IS NOT NULL AND void_reason ~ '[^[:space:]]'));

-- void_payment_batch()
--
-- Runtime requirement: 20261002000200 (tenant_credits, incl. reverses_credit_id).
-- plpgsql resolves tables at call time, so creating this function before that
-- migration is fine; calling it before is not.
--
-- Rules:
--  * Reason required; whitespace-only (spaces, tabs, newlines) is blank.
--  * Lock order: batch row, then every touched invoice in ascending id order,
--    then (only when an overpayment credit is reversed) the tenant row. Same
--    invoice order as record_payment_batch, so record/void cannot deadlock.
--  * All checks run before any write. Refuses (naming the invoice) when the
--    void would take an invoice's paid_amount below 0, i.e. paid_amount was
--    edited down after this receipt.
--  * Status after void:
--      cancelled / draft  -> unchanged (never silently reopened)
--      verifying          -> unchanged while a slip is awaiting review (slip_url
--                            set and not the slip this receipt was recorded
--                            from); otherwise treated like paid/partial
--      paid / partial     -> paid if still fully paid, partial if money
--                            remains, else overdue (due_date before today in
--                            Asia/Bangkok) or pending
--      pending / overdue  -> unchanged
--  * The batch's tenant_credits 'overpayment' rows are reversed by paired
--    'reversal' rows (reverses_credit_id, unique). If that credit was already
--    spent the void is refused rather than leaving a negative held balance.
--  * One 'payment.void' money_events row per invoice, one 'credit.reversal'
--    per reversed credit row.
CREATE OR REPLACE FUNCTION public.void_payment_batch(
    p_batch_id UUID,
    p_reason TEXT,
    p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_reason TEXT;
    v_batch public.payment_batches%ROWTYPE;
    v_alloc public.invoice_payment_allocations%ROWTYPE;
    v_inv public.invoices%ROWTYPE;
    v_rec RECORD;
    v_credit RECORD;
    v_ids UUID[];
    v_new_paid NUMERIC;
    v_new_status public.invoice_status;
    v_derived public.invoice_status;
    v_awaiting BOOLEAN;
    v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
    v_touched JSONB := '[]'::jsonb;
    v_count INT := 0;
    v_credit_total NUMERIC := 0;
    v_unapplied NUMERIC;
    v_credit_tenant UUID;
BEGIN
    IF p_reason IS NULL OR p_reason !~ '[^[:space:]]' THEN
        RAISE EXCEPTION 'A reason is required to void a payment';
    END IF;
    v_reason := regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g');

    SELECT * INTO v_batch FROM public.payment_batches WHERE id = p_batch_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment batch not found';
    END IF;
    IF v_batch.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'Payment batch already voided';
    END IF;

    -- Lock every invoice this batch paid, in id order, before reading balances.
    SELECT array_agg(DISTINCT invoice_id ORDER BY invoice_id) INTO v_ids
    FROM public.invoice_payment_allocations
    WHERE payment_batch_id = p_batch_id AND reverses_allocation_id IS NULL AND amount > 0;
    PERFORM 1 FROM public.invoices WHERE id = ANY(COALESCE(v_ids, '{}')) ORDER BY id FOR UPDATE;

    -- Check phase: nothing below may go negative.
    FOR v_rec IN
        SELECT a.invoice_id, SUM(a.amount) AS amount
        FROM public.invoice_payment_allocations a
        WHERE a.payment_batch_id = p_batch_id AND a.reverses_allocation_id IS NULL AND a.amount > 0
        GROUP BY a.invoice_id ORDER BY a.invoice_id
    LOOP
        SELECT * INTO v_inv FROM public.invoices WHERE id = v_rec.invoice_id;
        IF COALESCE(v_inv.paid_amount, 0) - v_rec.amount < 0 THEN
            RAISE EXCEPTION 'VOID_WOULD_MAKE_NEGATIVE invoice % has paid_amount % but this receipt allocated % to it; correct the invoice before voiding',
                v_rec.invoice_id, COALESCE(v_inv.paid_amount, 0), v_rec.amount;
        END IF;
    END LOOP;

    SELECT COALESCE(SUM(c.amount), 0), MIN(c.tenant_id::text)::uuid INTO v_credit_total, v_credit_tenant
    FROM public.tenant_credits c
    WHERE c.payment_batch_id = p_batch_id AND c.kind = 'overpayment'
      AND NOT EXISTS (SELECT 1 FROM public.tenant_credits r WHERE r.reverses_credit_id = c.id);
    IF v_credit_total > 0 THEN
        PERFORM 1 FROM public.tenants WHERE id = v_credit_tenant FOR UPDATE;
        SELECT COALESCE(SUM(amount), 0) INTO v_unapplied
        FROM public.tenant_credits WHERE tenant_id = v_credit_tenant AND bucket = 'unapplied';
        IF v_unapplied - v_credit_total < 0 THEN
            RAISE EXCEPTION 'VOID_CREDIT_ALREADY_USED this receipt left % as tenant credit but only % unapplied credit remains; reverse the credit use first',
                v_credit_total, v_unapplied;
        END IF;
    END IF;

    -- Write phase.
    FOR v_alloc IN
        SELECT * FROM public.invoice_payment_allocations
        WHERE payment_batch_id = p_batch_id
          AND reverses_allocation_id IS NULL
          AND amount > 0
        ORDER BY invoice_id, created_at, id
    LOOP
        INSERT INTO public.invoice_payment_allocations (
            payment_batch_id, trigger_invoice_id, invoice_id, amount, paid_at,
            slip_url, source, payment_method_id, payment_method_snapshot,
            reverses_allocation_id, reversed_at, reversal_reason
        ) VALUES (
            v_alloc.payment_batch_id, v_alloc.trigger_invoice_id, v_alloc.invoice_id,
            -v_alloc.amount, v_alloc.paid_at,
            v_alloc.slip_url, 'void', v_alloc.payment_method_id, v_alloc.payment_method_snapshot,
            v_alloc.id, now(), v_reason
        );
        v_count := v_count + 1;
    END LOOP;

    FOR v_rec IN
        SELECT a.invoice_id, SUM(a.amount) AS amount
        FROM public.invoice_payment_allocations a
        WHERE a.payment_batch_id = p_batch_id AND a.reverses_allocation_id IS NULL AND a.amount > 0
        GROUP BY a.invoice_id ORDER BY a.invoice_id
    LOOP
        SELECT * INTO v_inv FROM public.invoices WHERE id = v_rec.invoice_id;
        v_new_paid := COALESCE(v_inv.paid_amount, 0) - v_rec.amount;
        v_derived := CASE
            WHEN v_new_paid >= COALESCE(v_inv.total_amount, 0) THEN 'paid'
            WHEN v_new_paid > 0 THEN 'partial'
            WHEN v_inv.due_date IS NOT NULL AND v_inv.due_date < v_today THEN 'overdue'
            ELSE 'pending'
        END::public.invoice_status;
        v_awaiting := v_inv.status = 'verifying'
            AND COALESCE(btrim(v_inv.slip_url), '') <> ''
            AND (v_batch.slip_url IS NULL OR v_inv.slip_url <> v_batch.slip_url);

        v_new_status := CASE
            WHEN v_inv.status IN ('cancelled', 'draft') THEN v_inv.status
            WHEN v_inv.status = 'verifying' AND v_awaiting THEN v_inv.status
            WHEN v_inv.status IN ('paid', 'partial', 'verifying') THEN v_derived
            ELSE v_inv.status
        END;

        UPDATE public.invoices
        SET paid_amount = v_new_paid,
            status = v_new_status,
            payment_history = COALESCE(payment_history, '[]'::jsonb) || jsonb_build_array(
                jsonb_build_object(
                    'type', 'void',
                    'payment_batch_id', p_batch_id,
                    'amount', -v_rec.amount,
                    'reason', v_reason,
                    'voided_at', now()
                )
            )
        WHERE id = v_rec.invoice_id;

        INSERT INTO public.money_events (
            action, actor_user_id, tenant_id, invoice_id, payment_batch_id,
            before, after, reason, source
        ) VALUES (
            'payment.void', p_actor, COALESCE(v_inv.tenant_id, v_batch.tenant_id), v_rec.invoice_id, p_batch_id,
            jsonb_build_object('paid_amount', v_inv.paid_amount, 'status', v_inv.status, 'allocation_amount', v_rec.amount),
            jsonb_build_object('paid_amount', v_new_paid, 'status', v_new_status,
                               'status_kept', v_new_status = v_inv.status AND v_inv.status IN ('cancelled', 'draft', 'verifying')),
            v_reason, 'void_payment_batch'
        );

        v_touched := v_touched || to_jsonb(v_rec.invoice_id);
    END LOOP;

    FOR v_credit IN
        SELECT c.* FROM public.tenant_credits c
        WHERE c.payment_batch_id = p_batch_id AND c.kind = 'overpayment'
          AND NOT EXISTS (SELECT 1 FROM public.tenant_credits r WHERE r.reverses_credit_id = c.id)
        ORDER BY c.created_at, c.id
    LOOP
        INSERT INTO public.tenant_credits (
            tenant_id, kind, bucket, amount, invoice_id, payment_batch_id, reason, actor, reverses_credit_id
        ) VALUES (
            v_credit.tenant_id, 'reversal', v_credit.bucket, -v_credit.amount, v_credit.invoice_id,
            p_batch_id, 'Payment voided: ' || v_reason, p_actor, v_credit.id
        );
        INSERT INTO public.money_events (
            action, actor_user_id, tenant_id, payment_batch_id, before, after, reason, source
        ) VALUES (
            'credit.reversal', p_actor, v_credit.tenant_id, p_batch_id,
            jsonb_build_object('credit_id', v_credit.id, 'kind', v_credit.kind, 'amount', v_credit.amount),
            jsonb_build_object('reversal_amount', -v_credit.amount),
            v_reason, 'void_payment_batch'
        );
    END LOOP;

    UPDATE public.payment_batches
    SET voided_at = now(), voided_by = p_actor, void_reason = v_reason
    WHERE id = p_batch_id;

    RETURN jsonb_build_object('voided', true, 'reversed_allocations', v_count,
                              'touched_invoice_ids', v_touched, 'credit_reversed', v_credit_total);
END;
$$;

COMMENT ON FUNCTION public.void_payment_batch(UUID, TEXT, TEXT) IS
    'Atomically reverses a receipt: appends negative allocation rows, lowers invoices.paid_amount (never below 0), reverses its overpayment credit, logs money_events. Never deletes the receipt or its allocations.';

-- Server-only (service-role key); not reachable by anon/authenticated via /rpc.
REVOKE ALL ON FUNCTION public.void_payment_batch(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.void_payment_batch(UUID, TEXT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_payment_batch(UUID, TEXT, TEXT) TO service_role;
