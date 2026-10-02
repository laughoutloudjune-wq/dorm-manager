-- Atomic payment recording
--
-- Additive: one new function. NOT applied automatically.
-- Requires 20261002000000 (money_events) and 20261002000200 (tenant_credits).
-- Idempotent: CREATE OR REPLACE + REVOKE/GRANT can be re-run safely.
-- Rollback: DROP FUNCTION public.record_payment_batch(jsonb);
--
-- The application still does the calculation (allocation split, status,
-- late-fee freeze, payment_history entry). This function WRITES it, all or
-- nothing, and refuses any payload that does not add up, so a buggy or forged
-- caller cannot write arbitrary balances.
--
-- Guarantees:
--  * Lock order: every touched invoice (plus the trigger invoice) is locked
--    FOR UPDATE in ascending id order before anything is read or written, so
--    two concurrent multi-invoice payments cannot deadlock each other.
--  * Idempotency: checked AFTER the locks. Two requests with the same
--    (trigger_invoice_id, idempotency_key) always share the trigger-invoice
--    lock, so the second one waits, then sees the first one's committed batch
--    and replays it instead of failing STALE or recording twice. The unique
--    index remains the final arbiter (unique_violation -> replay). The batch row
--    is inserted before any invoice update, so that handler can never leave a
--    half-written payment behind.
--  * Staleness: each invoice must still have the paid_amount
--    (expected_paid_amount) AND the payment_history length
--    (expected_history_length) the caller read; otherwise STALE_INVOICE and
--    nothing is written. Existing payment_history entries are never
--    overwritten: only entries beyond the current length are appended.
--  * Ownership: every invoice (and the trigger invoice) must belong to
--    batch.tenant_id; with no tenant_id, to the trigger invoice's tenant.
--  * Arithmetic: amounts must be 2-decimal; each allocation > 0 and names an
--    invoice in invoices[]; each invoice in invoices[] receives an allocation;
--    allocations sum to amount_allocated; new paid_amount = old paid_amount +
--    that invoice's allocations and never exceeds total_amount; status is a
--    payment status consistent with the new balance; cancelled invoices cannot
--    receive money.
--  * Overpayment: amount_received - amount_allocated is kept as exactly one
--    tenant_credits 'overpayment' row. An excess without a tenant_id is refused
--    (it would otherwise be dropped).
--  * Audit: one 'payment.record' money_events row with per-invoice before/after.
--
-- Input shape (p):
--  { "batch": {id, tenant_id, trigger_invoice_id, amount_received, amount_allocated,
--              paid_at, mode, source, slip_url, payment_method_id,
--              payment_method_snapshot, idempotency_key, created_by},
--    "invoices": [{id, expected_paid_amount, expected_history_length, paid_amount,
--                  status, payment_history (optional, full array: current entries
--                  followed by the new ones), locked_late_fee_amount (optional),
--                  slip_url (optional), slip_uploaded_at (optional)}],
--    "allocations": [{invoice_id, amount, slip_url, source, payment_method_id,
--                     payment_method_snapshot}] }
--
-- Error prefixes (stable, callers may match on them): INVALID_PAYLOAD,
-- TENANT_REQUIRED, TENANT_MISMATCH, INVOICE_NOT_FOUND, INVOICE_NOT_PAYABLE,
-- STALE_INVOICE, OVERPAID_INVOICE.

CREATE OR REPLACE FUNCTION public.record_payment_batch(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_batch jsonb;
    v_invoices jsonb;
    v_allocs jsonb;
    v_batch_id uuid;
    v_trigger uuid;
    v_tenant uuid;
    v_owner uuid;
    v_key text;
    v_received numeric;
    v_allocated numeric;
    v_excess numeric;
    v_paid_at timestamptz;
    v_existing uuid;
    v_existing_voided boolean;
    v_inv jsonb;
    v_alloc jsonb;
    v_row public.invoices%ROWTYPE;
    v_ids uuid[];
    v_locked int;
    v_missing uuid;
    v_alloc_sum numeric;
    v_inv_alloc numeric;
    v_amount numeric;
    v_expected numeric;
    v_new_paid numeric;
    v_status text;
    v_exp_len int;
    v_cur_len int;
    v_new_hist jsonb;
    v_before jsonb := '[]'::jsonb;
    v_after jsonb := '[]'::jsonb;
BEGIN
    ------------------------------------------------------------------ shape
    IF p IS NULL OR jsonb_typeof(p->'batch') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD batch object is required';
    END IF;
    v_batch := p->'batch';
    v_invoices := COALESCE(p->'invoices', '[]'::jsonb);
    v_allocs := COALESCE(p->'allocations', '[]'::jsonb);
    IF jsonb_typeof(v_invoices) <> 'array' OR jsonb_typeof(v_allocs) <> 'array' THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD invoices and allocations must be arrays';
    END IF;

    v_batch_id := NULLIF(v_batch->>'id', '')::uuid;
    v_trigger := NULLIF(v_batch->>'trigger_invoice_id', '')::uuid;
    v_tenant := NULLIF(v_batch->>'tenant_id', '')::uuid;
    v_key := NULLIF(regexp_replace(COALESCE(v_batch->>'idempotency_key', ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
    v_received := (v_batch->>'amount_received')::numeric;
    v_allocated := (v_batch->>'amount_allocated')::numeric;
    v_paid_at := (v_batch->>'paid_at')::timestamptz;

    IF v_batch_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD batch.id is required';
    END IF;
    IF v_trigger IS NULL THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD batch.trigger_invoice_id is required';
    END IF;
    IF v_paid_at IS NULL THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD batch.paid_at is required';
    END IF;
    IF v_received IS NULL OR v_received <= 0 THEN
        RAISE EXCEPTION 'amount_received must be greater than 0';
    END IF;
    IF v_allocated IS NULL OR v_allocated < 0 OR v_allocated > v_received THEN
        RAISE EXCEPTION 'amount_allocated must be between 0 and amount_received';
    END IF;
    IF v_received <> round(v_received, 2) OR v_allocated <> round(v_allocated, 2) THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD amounts must have at most 2 decimals (received %, allocated %)', v_received, v_allocated;
    END IF;
    v_excess := v_received - v_allocated;
    IF v_excess > 0 AND v_tenant IS NULL THEN
        RAISE EXCEPTION 'TENANT_REQUIRED amount_received exceeds amount_allocated by % but batch.tenant_id is missing, so the excess could not be kept as credit', v_excess;
    END IF;

    ------------------------------------------------------------------ allocations
    FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_allocs) LOOP
        IF NULLIF(v_alloc->>'invoice_id', '') IS NULL THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD every allocation needs invoice_id';
        END IF;
        v_amount := (v_alloc->>'amount')::numeric;
        IF v_amount IS NULL OR v_amount <= 0 THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD allocation for invoice % must be greater than 0 (got %)', v_alloc->>'invoice_id', v_amount;
        END IF;
        IF v_amount <> round(v_amount, 2) THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD allocation % for invoice % has more than 2 decimals', v_amount, v_alloc->>'invoice_id';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_invoices) i
            WHERE NULLIF(i->>'id', '')::uuid = (v_alloc->>'invoice_id')::uuid
        ) THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD allocation for invoice % has no matching entry in invoices[]', v_alloc->>'invoice_id';
        END IF;
    END LOOP;

    SELECT COALESCE(SUM((a->>'amount')::numeric), 0) INTO v_alloc_sum
    FROM jsonb_array_elements(v_allocs) a;
    IF v_alloc_sum <> v_allocated THEN
        RAISE EXCEPTION 'allocations (%) do not equal amount_allocated (%)', v_alloc_sum, v_allocated;
    END IF;

    ------------------------------------------------------------------ invoices[] shape
    FOR v_inv IN SELECT * FROM jsonb_array_elements(v_invoices) LOOP
        IF NULLIF(v_inv->>'id', '') IS NULL THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD every invoices[] entry needs id';
        END IF;
        IF NOT (v_inv ? 'expected_paid_amount') OR jsonb_typeof(v_inv->'expected_paid_amount') <> 'number' THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD invoice % needs a numeric expected_paid_amount', v_inv->>'id';
        END IF;
        IF NOT (v_inv ? 'expected_history_length') OR jsonb_typeof(v_inv->'expected_history_length') <> 'number'
           OR (v_inv->>'expected_history_length')::numeric < 0
           OR (v_inv->>'expected_history_length')::numeric <> trunc((v_inv->>'expected_history_length')::numeric) THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD invoice % needs a non-negative integer expected_history_length', v_inv->>'id';
        END IF;
        IF NOT (v_inv ? 'paid_amount') OR jsonb_typeof(v_inv->'paid_amount') <> 'number' THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD invoice % needs a numeric paid_amount', v_inv->>'id';
        END IF;
        v_status := v_inv->>'status';
        IF v_status IS NULL OR v_status NOT IN ('pending', 'partial', 'overdue', 'verifying', 'paid') THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD invoice % status % is not a valid payment status', v_inv->>'id', COALESCE(v_status, 'NULL');
        END IF;
        IF v_inv ? 'payment_history' AND jsonb_typeof(v_inv->'payment_history') <> 'array' THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD invoice % payment_history must be an array', v_inv->>'id';
        END IF;
    END LOOP;

    IF (SELECT count(*) FROM jsonb_array_elements(v_invoices))
       <> (SELECT count(DISTINCT (i->>'id')::uuid) FROM jsonb_array_elements(v_invoices) i) THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD invoices[] lists the same invoice more than once';
    END IF;

    ------------------------------------------------------------------ lock (deterministic order)
    SELECT array_agg(x ORDER BY x) INTO v_ids FROM (
        SELECT (i->>'id')::uuid AS x FROM jsonb_array_elements(v_invoices) i
        UNION
        SELECT v_trigger
    ) s;

    SELECT count(*) INTO v_locked FROM (
        SELECT id FROM public.invoices WHERE id = ANY(v_ids) ORDER BY id FOR UPDATE
    ) l;
    IF v_locked <> cardinality(v_ids) THEN
        SELECT x INTO v_missing FROM unnest(v_ids) x
        WHERE NOT EXISTS (SELECT 1 FROM public.invoices WHERE id = x) LIMIT 1;
        RAISE EXCEPTION 'INVOICE_NOT_FOUND %', v_missing;
    END IF;

    ------------------------------------------------------------------ idempotent replay (after locks)
    IF v_key IS NOT NULL THEN
        SELECT id, voided_at IS NOT NULL INTO v_existing, v_existing_voided FROM public.payment_batches
        WHERE trigger_invoice_id = v_trigger AND idempotency_key = v_key;
        IF FOUND THEN
            RETURN jsonb_build_object('replayed', true, 'payment_batch_id', v_existing, 'voided', v_existing_voided);
        END IF;
    END IF;

    ------------------------------------------------------------------ ownership
    SELECT tenant_id INTO v_owner FROM public.invoices WHERE id = v_trigger;
    IF v_tenant IS NOT NULL AND v_owner IS DISTINCT FROM v_tenant THEN
        RAISE EXCEPTION 'TENANT_MISMATCH trigger invoice % belongs to tenant %, not batch tenant %', v_trigger, v_owner, v_tenant;
    END IF;
    v_owner := COALESCE(v_tenant, v_owner);

    ------------------------------------------------------------------ per-invoice validation (read-only)
    FOR v_inv IN SELECT * FROM jsonb_array_elements(v_invoices) LOOP
        SELECT * INTO v_row FROM public.invoices WHERE id = (v_inv->>'id')::uuid;

        IF v_row.tenant_id IS DISTINCT FROM v_owner THEN
            RAISE EXCEPTION 'TENANT_MISMATCH invoice % belongs to tenant %, not %', v_row.id, v_row.tenant_id, v_owner;
        END IF;
        IF v_row.status::text = 'cancelled' THEN
            RAISE EXCEPTION 'INVOICE_NOT_PAYABLE invoice % is cancelled', v_row.id;
        END IF;

        v_expected := (v_inv->>'expected_paid_amount')::numeric;
        IF COALESCE(v_row.paid_amount, 0) <> v_expected THEN
            RAISE EXCEPTION 'STALE_INVOICE % (paid_amount changed from % to %)',
                v_row.id, v_expected, v_row.paid_amount;
        END IF;
        v_exp_len := (v_inv->>'expected_history_length')::int;
        v_cur_len := jsonb_array_length(COALESCE(v_row.payment_history, '[]'::jsonb));
        IF v_cur_len <> v_exp_len THEN
            RAISE EXCEPTION 'STALE_INVOICE % (payment_history changed from % to % entries)',
                v_row.id, v_exp_len, v_cur_len;
        END IF;

        SELECT COALESCE(SUM((a->>'amount')::numeric), 0) INTO v_inv_alloc
        FROM jsonb_array_elements(v_allocs) a
        WHERE (a->>'invoice_id')::uuid = v_row.id;
        IF v_inv_alloc <= 0 THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD invoice % is in invoices[] but receives no allocation', v_row.id;
        END IF;

        v_new_paid := (v_inv->>'paid_amount')::numeric;
        IF v_new_paid <> COALESCE(v_row.paid_amount, 0) + v_inv_alloc THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD invoice % paid_amount % must equal current % plus its allocations %',
                v_row.id, v_new_paid, COALESCE(v_row.paid_amount, 0), v_inv_alloc;
        END IF;
        IF v_new_paid > COALESCE(v_row.total_amount, 0) THEN
            RAISE EXCEPTION 'OVERPAID_INVOICE invoice % would reach paid_amount % above its total %; keep the excess as credit instead',
                v_row.id, v_new_paid, COALESCE(v_row.total_amount, 0);
        END IF;
        v_status := v_inv->>'status';
        IF v_status = 'paid' AND v_new_paid < COALESCE(v_row.total_amount, 0) THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD invoice % cannot be marked paid with paid_amount % below total %',
                v_row.id, v_new_paid, COALESCE(v_row.total_amount, 0);
        END IF;
        IF v_inv ? 'payment_history' AND jsonb_array_length(v_inv->'payment_history') < v_cur_len THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD invoice % payment_history would drop existing entries', v_row.id;
        END IF;
        IF v_inv ? 'locked_late_fee_amount' AND jsonb_typeof(v_inv->'locked_late_fee_amount') NOT IN ('number', 'null') THEN
            RAISE EXCEPTION 'INVALID_PAYLOAD invoice % locked_late_fee_amount must be a number', v_row.id;
        END IF;
    END LOOP;

    ------------------------------------------------------------------ write: batch first
    BEGIN
        INSERT INTO public.payment_batches (
            id, tenant_id, trigger_invoice_id, amount_received, amount_allocated, paid_at,
            mode, source, slip_url, payment_method_id, payment_method_snapshot,
            idempotency_key, created_by
        ) VALUES (
            v_batch_id, v_tenant, v_trigger, v_received, v_allocated, v_paid_at,
            v_batch->>'mode', v_batch->>'source',
            v_batch->>'slip_url', NULLIF(v_batch->>'payment_method_id', '')::uuid,
            v_batch->'payment_method_snapshot', v_key, v_batch->>'created_by'
        );
    EXCEPTION WHEN unique_violation THEN
        -- Backstop: a concurrent request with the same key won. Nothing else has
        -- been written yet by this call, so returning here is clean.
        IF v_key IS NOT NULL THEN
            SELECT id, voided_at IS NOT NULL INTO v_existing, v_existing_voided FROM public.payment_batches
            WHERE trigger_invoice_id = v_trigger AND idempotency_key = v_key;
            IF FOUND THEN
                RETURN jsonb_build_object('replayed', true, 'payment_batch_id', v_existing, 'voided', v_existing_voided);
            END IF;
        END IF;
        RAISE;
    END;

    ------------------------------------------------------------------ write: invoices
    FOR v_inv IN
        SELECT i FROM jsonb_array_elements(v_invoices) i ORDER BY (i->>'id')::uuid
    LOOP
        SELECT * INTO v_row FROM public.invoices WHERE id = (v_inv->>'id')::uuid;
        v_cur_len := jsonb_array_length(COALESCE(v_row.payment_history, '[]'::jsonb));

        -- Keep every stored entry exactly as stored; take only the caller's new tail.
        IF v_inv ? 'payment_history' THEN
            SELECT COALESCE(v_row.payment_history, '[]'::jsonb)
                   || COALESCE(jsonb_agg(e ORDER BY n), '[]'::jsonb)
            INTO v_new_hist
            FROM jsonb_array_elements(v_inv->'payment_history') WITH ORDINALITY t(e, n)
            WHERE n > v_cur_len;
        ELSE
            v_new_hist := v_row.payment_history;
        END IF;

        UPDATE public.invoices SET
            paid_amount = (v_inv->>'paid_amount')::numeric,
            status = (v_inv->>'status')::public.invoice_status,
            payment_history = v_new_hist,
            locked_late_fee_amount = CASE WHEN v_inv ? 'locked_late_fee_amount'
                THEN (v_inv->>'locked_late_fee_amount')::numeric ELSE locked_late_fee_amount END,
            slip_url = CASE WHEN v_inv ? 'slip_url' THEN v_inv->>'slip_url' ELSE slip_url END,
            slip_uploaded_at = CASE WHEN v_inv ? 'slip_uploaded_at'
                THEN (v_inv->>'slip_uploaded_at')::timestamptz ELSE slip_uploaded_at END
        WHERE id = v_row.id;

        v_before := v_before || jsonb_build_array(jsonb_build_object(
            'invoice_id', v_row.id, 'paid_amount', v_row.paid_amount, 'status', v_row.status,
            'history_length', v_cur_len));
        v_after := v_after || jsonb_build_array(jsonb_build_object(
            'invoice_id', v_row.id, 'paid_amount', (v_inv->>'paid_amount')::numeric,
            'status', v_inv->>'status', 'history_length', jsonb_array_length(COALESCE(v_new_hist, '[]'::jsonb))));
    END LOOP;

    ------------------------------------------------------------------ write: allocations, credit, event
    INSERT INTO public.invoice_payment_allocations (
        payment_batch_id, trigger_invoice_id, invoice_id, amount, paid_at, slip_url,
        source, payment_method_id, payment_method_snapshot
    )
    SELECT v_batch_id, v_trigger, (a->>'invoice_id')::uuid, (a->>'amount')::numeric,
           v_paid_at, a->>'slip_url', COALESCE(a->>'source', v_batch->>'source'),
           COALESCE(NULLIF(a->>'payment_method_id', ''), NULLIF(v_batch->>'payment_method_id', ''))::uuid,
           COALESCE(a->'payment_method_snapshot', v_batch->'payment_method_snapshot')
    FROM jsonb_array_elements(v_allocs) a;

    IF v_excess > 0 THEN
        INSERT INTO public.tenant_credits (tenant_id, kind, bucket, amount, payment_batch_id, reason, actor)
        VALUES (v_tenant, 'overpayment', 'unapplied', v_excess,
                v_batch_id, 'Receipt exceeded open balance', v_batch->>'created_by');
    END IF;

    INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, payment_batch_id, before, after, source)
    VALUES ('payment.record', v_batch->>'created_by', v_tenant, v_trigger, v_batch_id,
            jsonb_build_object('invoices', v_before),
            jsonb_build_object('amount_received', v_received, 'amount_allocated', v_allocated,
                               'credit', v_excess, 'paid_at', v_paid_at,
                               'idempotency_key', v_key,
                               'allocations', v_allocs, 'invoices', v_after),
            v_batch->>'source');

    RETURN jsonb_build_object('replayed', false, 'payment_batch_id', v_batch_id,
                              'unapplied_credit', v_excess);
END;
$$;

COMMENT ON FUNCTION public.record_payment_batch(jsonb) IS
    'Atomically records one receipt: batch, invoice updates (locked in id order, stale check on paid_amount and payment_history length, ownership and arithmetic validated), allocations, overpayment credit, audit event. Idempotent per (trigger_invoice_id, idempotency_key).';

-- Server-only: the app calls this with the service-role key. Never let the
-- public anon/authenticated roles reach it through PostgREST /rpc.
REVOKE ALL ON FUNCTION public.record_payment_batch(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_payment_batch(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_batch(jsonb) TO service_role;
