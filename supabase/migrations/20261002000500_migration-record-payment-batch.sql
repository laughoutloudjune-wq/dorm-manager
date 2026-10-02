-- Atomic payment recording
--
-- Additive: one new function. NOT applied automatically.
-- Requires 20261002000200 (tenant_credits) for the overpayment credit row.
-- Rollback: DROP FUNCTION public.record_payment_batch(jsonb);
--
-- The application still does the calculation (allocation split, status,
-- late-fee freeze, payment_history entry). This function only WRITES it, all or
-- nothing, which replaces the old sequence of separate inserts/updates that
-- tried to undo itself by hand when one step failed.
--
-- Guarantees:
--  * Idempotency: a retry with the same (trigger_invoice_id, idempotency_key)
--    returns the original batch instead of recording a second receipt, even
--    when two requests race (the unique index is the arbiter).
--  * Concurrency: every touched invoice is locked and must still have the
--    paid_amount the caller calculated from (expected_paid_amount); otherwise
--    the whole call fails with STALE_INVOICE and nothing is written.
--  * Overpayment: amount_received may exceed amount_allocated; the excess is
--    kept as a tenant_credits 'overpayment' row, never dropped.
--  * Totals: allocation rows must sum to amount_allocated.
--
-- Input shape (p):
--  { "batch": {id, tenant_id, trigger_invoice_id, amount_received, amount_allocated,
--              paid_at, mode, source, slip_url, payment_method_id,
--              payment_method_snapshot, idempotency_key, created_by},
--    "invoices": [{id, expected_paid_amount, paid_amount, status, payment_history,
--                  locked_late_fee_amount (optional), slip_url (optional),
--                  slip_uploaded_at (optional)}],
--    "allocations": [{invoice_id, amount, ...}] }

CREATE OR REPLACE FUNCTION public.record_payment_batch(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_batch jsonb := p->'batch';
    v_batch_id uuid := (v_batch->>'id')::uuid;
    v_trigger uuid := (v_batch->>'trigger_invoice_id')::uuid;
    v_key text := NULLIF(btrim(COALESCE(v_batch->>'idempotency_key', '')), '');
    v_received numeric := (v_batch->>'amount_received')::numeric;
    v_allocated numeric := (v_batch->>'amount_allocated')::numeric;
    v_existing uuid;
    v_inv jsonb;
    v_row public.invoices%ROWTYPE;
    v_alloc_sum numeric;
BEGIN
    IF v_received IS NULL OR v_received <= 0 THEN
        RAISE EXCEPTION 'amount_received must be greater than 0';
    END IF;
    IF v_allocated IS NULL OR v_allocated < 0 OR v_allocated > v_received THEN
        RAISE EXCEPTION 'amount_allocated must be between 0 and amount_received';
    END IF;

    SELECT COALESCE(SUM((a->>'amount')::numeric), 0) INTO v_alloc_sum
    FROM jsonb_array_elements(COALESCE(p->'allocations', '[]'::jsonb)) a;
    IF v_alloc_sum <> v_allocated THEN
        RAISE EXCEPTION 'allocations (%) do not equal amount_allocated (%)', v_alloc_sum, v_allocated;
    END IF;

    IF v_key IS NOT NULL THEN
        SELECT id INTO v_existing FROM public.payment_batches
        WHERE trigger_invoice_id = v_trigger AND idempotency_key = v_key;
        IF FOUND THEN
            RETURN jsonb_build_object('replayed', true, 'payment_batch_id', v_existing);
        END IF;
    END IF;

    BEGIN
        INSERT INTO public.payment_batches (
            id, tenant_id, trigger_invoice_id, amount_received, amount_allocated, paid_at,
            mode, source, slip_url, payment_method_id, payment_method_snapshot,
            idempotency_key, created_by
        ) VALUES (
            v_batch_id, NULLIF(v_batch->>'tenant_id','')::uuid, v_trigger, v_received, v_allocated,
            (v_batch->>'paid_at')::timestamptz, v_batch->>'mode', v_batch->>'source',
            v_batch->>'slip_url', NULLIF(v_batch->>'payment_method_id','')::uuid,
            v_batch->'payment_method_snapshot', v_key, v_batch->>'created_by'
        );
    EXCEPTION WHEN unique_violation THEN
        -- A concurrent request with the same key won the race.
        SELECT id INTO v_existing FROM public.payment_batches
        WHERE trigger_invoice_id = v_trigger AND idempotency_key = v_key;
        IF FOUND THEN
            RETURN jsonb_build_object('replayed', true, 'payment_batch_id', v_existing);
        END IF;
        RAISE;
    END;

    FOR v_inv IN SELECT * FROM jsonb_array_elements(COALESCE(p->'invoices', '[]'::jsonb))
    LOOP
        SELECT * INTO v_row FROM public.invoices WHERE id = (v_inv->>'id')::uuid FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'INVOICE_NOT_FOUND %', v_inv->>'id';
        END IF;
        IF COALESCE(v_row.paid_amount, 0) <> (v_inv->>'expected_paid_amount')::numeric THEN
            RAISE EXCEPTION 'STALE_INVOICE % (paid_amount changed from % to %)',
                v_inv->>'id', v_inv->>'expected_paid_amount', v_row.paid_amount;
        END IF;

        UPDATE public.invoices SET
            paid_amount = (v_inv->>'paid_amount')::numeric,
            status = (v_inv->>'status')::public.invoice_status,
            payment_history = COALESCE(v_inv->'payment_history', payment_history),
            locked_late_fee_amount = CASE WHEN v_inv ? 'locked_late_fee_amount'
                THEN (v_inv->>'locked_late_fee_amount')::numeric ELSE locked_late_fee_amount END,
            slip_url = CASE WHEN v_inv ? 'slip_url' THEN v_inv->>'slip_url' ELSE slip_url END,
            slip_uploaded_at = CASE WHEN v_inv ? 'slip_uploaded_at'
                THEN (v_inv->>'slip_uploaded_at')::timestamptz ELSE slip_uploaded_at END
        WHERE id = v_row.id;
    END LOOP;

    INSERT INTO public.invoice_payment_allocations (
        payment_batch_id, trigger_invoice_id, invoice_id, amount, paid_at, slip_url,
        source, payment_method_id, payment_method_snapshot
    )
    SELECT v_batch_id, v_trigger, (a->>'invoice_id')::uuid, (a->>'amount')::numeric,
           (v_batch->>'paid_at')::timestamptz, a->>'slip_url', a->>'source',
           NULLIF(a->>'payment_method_id','')::uuid, a->'payment_method_snapshot'
    FROM jsonb_array_elements(COALESCE(p->'allocations', '[]'::jsonb)) a;

    IF v_received > v_allocated AND NULLIF(v_batch->>'tenant_id','') IS NOT NULL THEN
        INSERT INTO public.tenant_credits (tenant_id, kind, bucket, amount, payment_batch_id, reason, actor)
        VALUES ((v_batch->>'tenant_id')::uuid, 'overpayment', 'unapplied', v_received - v_allocated,
                v_batch_id, 'Receipt exceeded open balance', v_batch->>'created_by');
    END IF;

    INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, payment_batch_id, after, source)
    VALUES ('payment.record', v_batch->>'created_by', NULLIF(v_batch->>'tenant_id','')::uuid, v_trigger,
            v_batch_id,
            jsonb_build_object('amount_received', v_received, 'amount_allocated', v_allocated,
                               'credit', v_received - v_allocated),
            v_batch->>'source');

    RETURN jsonb_build_object('replayed', false, 'payment_batch_id', v_batch_id,
                              'unapplied_credit', v_received - v_allocated);
END;
$$;

COMMENT ON FUNCTION public.record_payment_batch IS
    'Atomically records one receipt: batch, invoice updates (with stale-balance check), allocations, overpayment credit, audit event. Idempotent per (trigger_invoice_id, idempotency_key).';
