-- Refund payouts and move-out settlement correction
--
-- Additive: three functions, no table changes. NOT applied automatically. Rollback: DROP FUNCTION for each
-- (see end of file); the audit rows (refund_payouts, money_events, reversal rows) stay and need a backup restore
-- to remove. Requires 20261002000000 (money_events, rederive helpers), 0200 (tenant_credits), 0300 (refund_payouts
-- and view refund_due_vs_paid) and 0600 (move_out_settlements, final_settle_move_out).
--
-- Global lock order (same as the other money functions): tenant -> room -> invoices (ascending id) -> other rows.
--
-- 1. record_refund_payout(p)   money actually sent to a tenant, against REFUND DUE only
--    * allowed only after a live (unvoided) move-out settlement: held deposit before settlement is not "due"
--    * capped at refund_due_vs_paid.refund_outstanding; advance rent is not in that figure (owner decision: never refundable)
--    * requires method, recipient and a reference or evidence link; paid_at must not be after now() (PAID_AT_IN_FUTURE, no tolerance)
--    * idempotent on idempotency_key; the same key with a different tenant or amount is IDEMPOTENCY_CONFLICT
--    * payouts are the record of money sent: no 'refunded' tenant_credits row is written (the view excludes them)
-- 2. void_refund_payout(p)     reverses a mistaken payout (append-only: sets void columns, reason required)
-- 3. void_move_out_settlement(p)  reverses an erroneous settlement atomically:
--    reverses the non-cash credit payments on older invoices (negative allocation rows, paid_amount lowered, statuses re-derived,
--    downstream targets re-derived), reverses the applied/forfeited/absorbed tenant_credits rows written by that settlement
--    (the held deposit / advance returns), cancels the final invoice, un-bills the late fees it billed or voided (restoring each source invoice exactly), restores tenant, room, room log and move-out request from the state saved with the settlement (move_out_settlements.tenant_before; refuses BEFORE_STATE_MISSING when absent),
--    marks the settlement voided. Refuses when: a refund payout is still live (void it first), the room has been re-let, the tenant's state or any later settlement / move-out request / tenancy record / payment / credit / invoice shows activity after the settlement (LATER_ACTIVITY),
--    the tenant is no longer in the settled state, the final invoice has had payments, or reversing would make an
--    invoice's paid_amount negative. Settlement rows are recognised by created_at = the settlement's created_at: every row
--    written by one settlement shares the transaction timestamp.

CREATE OR REPLACE FUNCTION public.record_refund_payout(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tenant UUID := NULLIF(p->>'tenant_id', '')::uuid;
    v_amount NUMERIC;
    v_key TEXT := btrim(COALESCE(p->>'idempotency_key', ''), E' \t\r\n');
    v_method TEXT := btrim(COALESCE(p->>'method', ''), E' \t\r\n');
    v_recipient TEXT := btrim(COALESCE(p->>'recipient', ''), E' \t\r\n');
    v_reference TEXT := NULLIF(btrim(COALESCE(p->>'reference', ''), E' \t\r\n'), '');
    v_evidence TEXT := NULLIF(btrim(COALESCE(p->>'evidence_url', ''), E' \t\r\n'), '');
    v_actor TEXT := p->>'actor';
    v_paid_at TIMESTAMPTZ;
    v_existing public.refund_payouts%ROWTYPE;
    v_due NUMERIC;
    v_paid NUMERIC;
    v_id UUID;
BEGIN
    IF v_tenant IS NULL THEN RAISE EXCEPTION 'INVALID_PAYLOAD tenant_id is required'; END IF;
    IF jsonb_typeof(p->'amount') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'INVALID_PAYLOAD amount must be a number'; END IF;
    v_amount := (p->>'amount')::numeric;
    IF v_amount <= 0 OR v_amount <> round(v_amount, 2) THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD amount must be greater than 0 with at most 2 decimals (got %)', v_amount;
    END IF;
    IF v_key = '' THEN RAISE EXCEPTION 'INVALID_PAYLOAD idempotency_key is required'; END IF;
    IF v_method = '' THEN RAISE EXCEPTION 'INVALID_PAYLOAD method is required'; END IF;
    IF v_recipient = '' THEN RAISE EXCEPTION 'INVALID_PAYLOAD recipient is required'; END IF;
    IF v_reference IS NULL AND v_evidence IS NULL THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD a reference or an evidence link is required';
    END IF;
    BEGIN
        v_paid_at := (p->>'paid_at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD paid_at is not a valid date';
    END;
    IF v_paid_at IS NULL THEN RAISE EXCEPTION 'INVALID_PAYLOAD paid_at is required'; END IF;
    -- Business rule: a payout cannot be dated after the moment it is recorded. No tolerance.
    IF v_paid_at > now() THEN
        RAISE EXCEPTION 'PAID_AT_IN_FUTURE paid_at % is after the current time %', v_paid_at, now();
    END IF;

    PERFORM 1 FROM public.tenants WHERE id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'TENANT_NOT_FOUND %', v_tenant; END IF;

    SELECT * INTO v_existing FROM public.refund_payouts WHERE idempotency_key = v_key;
    IF FOUND THEN
        IF v_existing.tenant_id <> v_tenant OR v_existing.amount <> v_amount THEN
            RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT key % was already used for a different refund payout (%)', v_key, v_existing.id;
        END IF;
        RETURN jsonb_build_object('replayed', true, 'payout_id', v_existing.id, 'voided', v_existing.voided_at IS NOT NULL);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.move_out_settlements WHERE tenant_id = v_tenant AND voided_at IS NULL) THEN
        RAISE EXCEPTION 'NOT_SETTLED tenant % has no live move-out settlement; a refund is only due after settlement', v_tenant;
    END IF;

    SELECT COALESCE(refund_due, 0), COALESCE(refund_paid, 0) INTO v_due, v_paid
    FROM public.refund_due_vs_paid WHERE tenant_id = v_tenant;
    v_due := COALESCE(v_due, 0);
    v_paid := COALESCE(v_paid, 0);
    IF v_amount > v_due - v_paid THEN
        RAISE EXCEPTION 'REFUND_EXCEEDS_DUE refund due % minus already paid % leaves % but % was requested',
            v_due, v_paid, v_due - v_paid, v_amount;
    END IF;

    INSERT INTO public.refund_payouts (tenant_id, amount, paid_at, method, payment_method_snapshot, recipient,
                                       reference, evidence_url, actor, idempotency_key)
    VALUES (v_tenant, v_amount, v_paid_at, v_method, p->'payment_method_snapshot', v_recipient,
            v_reference, v_evidence, v_actor, v_key)
    RETURNING id INTO v_id;

    INSERT INTO public.money_events (action, actor_user_id, tenant_id, after, reason, source)
    VALUES ('refund.payout', v_actor, v_tenant,
            jsonb_build_object('payout_id', v_id, 'amount', v_amount, 'paid_at', v_paid_at, 'method', v_method,
                               'recipient', v_recipient, 'reference', v_reference, 'evidence_url', v_evidence,
                               'refund_due', v_due, 'paid_before', v_paid, 'outstanding_after', v_due - v_paid - v_amount),
            'Refund paid out to tenant', 'record_refund_payout');

    RETURN jsonb_build_object('replayed', false, 'payout_id', v_id, 'outstanding_after', v_due - v_paid - v_amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.void_refund_payout(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id UUID := NULLIF(p->>'payout_id', '')::uuid;
    v_reason TEXT := btrim(COALESCE(p->>'reason', ''), E' \t\r\n');
    v_actor TEXT := p->>'actor';
    v_row public.refund_payouts%ROWTYPE;
BEGIN
    IF v_id IS NULL THEN RAISE EXCEPTION 'INVALID_PAYLOAD payout_id is required'; END IF;
    IF v_reason = '' THEN RAISE EXCEPTION 'REASON_REQUIRED a reason is required to void a refund payout'; END IF;
    SELECT * INTO v_row FROM public.refund_payouts WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'PAYOUT_NOT_FOUND %', v_id; END IF;
    PERFORM 1 FROM public.tenants WHERE id = v_row.tenant_id FOR UPDATE;
    SELECT * INTO v_row FROM public.refund_payouts WHERE id = v_id FOR UPDATE;
    IF v_row.voided_at IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_VOIDED refund payout % was already voided', v_id; END IF;

    UPDATE public.refund_payouts SET voided_at = now(), voided_by = v_actor, void_reason = v_reason WHERE id = v_id;

    INSERT INTO public.money_events (action, actor_user_id, tenant_id, before, after, reason, source)
    VALUES ('refund.void', v_actor, v_row.tenant_id,
            jsonb_build_object('payout_id', v_id, 'amount', v_row.amount, 'paid_at', v_row.paid_at),
            jsonb_build_object('voided', true), v_reason, 'void_refund_payout');
    RETURN jsonb_build_object('voided', true, 'payout_id', v_id, 'amount', v_row.amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.void_move_out_settlement(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id UUID := NULLIF(p->>'settlement_id', '')::uuid;
    v_reason TEXT := btrim(COALESCE(p->>'reason', ''), E' \t\r\n');
    v_by TEXT := p->>'actor';
    v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
    v_tid UUID;
    v_s public.move_out_settlements%ROWTYPE;
    v_tenant public.tenants%ROWTYPE;
    v_final public.invoices%ROWTYPE;
    v_batch public.payment_batches%ROWTYPE;
    v_inv public.invoices%ROWTYPE;
    v_alloc public.invoice_payment_allocations%ROWTYPE;
    v_r RECORD;
    v_overrides JSONB := '{}'::jsonb;
    v_touched UUID[] := '{}';
    v_downstream UUID[] := '{}';
    v_new_paid NUMERIC;
    v_new_status public.invoice_status;
    v_status_before TEXT;
    v_room_before UUID;
    v_credit_rows INT := 0;
    v_tb JSONB;
    v_settled_date DATE;
    v_log JSONB;
    v_req JSONB;
    v_cnt INT;
    v_lfe JSONB;
BEGIN
    IF v_id IS NULL THEN RAISE EXCEPTION 'INVALID_PAYLOAD settlement_id is required'; END IF;
    IF v_reason = '' THEN RAISE EXCEPTION 'REASON_REQUIRED a reason is required to void a settlement'; END IF;

    SELECT tenant_id INTO v_tid FROM public.move_out_settlements WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND %', v_id; END IF;

    -- lock order: tenant -> room -> the tenant's invoices (ascending id) -> settlement row
    SELECT * INTO v_tenant FROM public.tenants WHERE id = v_tid FOR UPDATE;
    SELECT * INTO v_s FROM public.move_out_settlements WHERE id = v_id FOR UPDATE;
    IF v_s.voided_at IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_VOIDED settlement % was already voided', v_id; END IF;
    IF v_s.room_id IS NULL THEN RAISE EXCEPTION 'ROOM_UNKNOWN settlement % has no room to restore', v_id; END IF;
    PERFORM 1 FROM public.rooms WHERE id = v_s.room_id FOR UPDATE;
    PERFORM 1 FROM public.invoices WHERE tenant_id = v_tid ORDER BY id FOR UPDATE;

    ---------------------------------------------------------------- guards
    IF EXISTS (SELECT 1 FROM public.refund_payouts WHERE tenant_id = v_tid AND voided_at IS NULL) THEN
        RAISE EXCEPTION 'SETTLEMENT_HAS_PAYOUT a refund was paid out for this tenant; void the refund payout first';
    END IF;
    IF EXISTS (SELECT 1 FROM public.tenants WHERE room_id = v_s.room_id AND status = 'active') THEN
        RAISE EXCEPTION 'ROOM_REOCCUPIED room % already has an active tenant', v_s.room_id;
    END IF;
    v_tb := v_s.tenant_before;
    IF v_tb IS NULL THEN
        RAISE EXCEPTION 'BEFORE_STATE_MISSING settlement % was recorded without its pre-settlement state, so it cannot be reversed automatically; correct the tenant by hand and record why', v_id;
    END IF;
    v_settled_date := NULLIF(v_tb->>'settled_move_out_date', '')::date;
    -- The tenant must still be exactly as the settlement left it.
    IF v_tenant.status IS DISTINCT FROM 'inactive' OR v_tenant.room_id IS NOT NULL
       OR v_tenant.move_out_date IS DISTINCT FROM v_settled_date THEN
        RAISE EXCEPTION 'TENANT_STATE_CHANGED the tenant is no longer in the settled state (status %, room %, move-out date %)',
            v_tenant.status, v_tenant.room_id, v_tenant.move_out_date;
    END IF;
    -- Only the tenant's latest settlement can be reversed, and only if nothing happened after it that a reversal would overwrite.
    IF EXISTS (SELECT 1 FROM public.move_out_settlements x WHERE x.id <> v_id AND x.created_at > v_s.created_at
               AND (x.tenant_id = v_tid OR x.room_id = v_s.room_id)) THEN
        RAISE EXCEPTION 'LATER_ACTIVITY a later move-out settlement exists for this tenant or room';
    END IF;
    IF EXISTS (SELECT 1 FROM public.move_out_requests WHERE tenant_id = v_tid AND created_at > v_s.created_at) THEN
        RAISE EXCEPTION 'LATER_ACTIVITY a move-out request was filed after this settlement';
    END IF;
    IF EXISTS (SELECT 1 FROM public.room_tenant_logs WHERE room_id = v_s.room_id AND created_at > v_s.created_at) THEN
        RAISE EXCEPTION 'LATER_ACTIVITY the room has a newer tenancy record since this settlement';
    END IF;
    IF EXISTS (SELECT 1 FROM public.payment_batches WHERE tenant_id = v_tid AND created_at > v_s.created_at AND voided_at IS NULL) THEN
        RAISE EXCEPTION 'LATER_ACTIVITY a payment was recorded for this tenant after the settlement';
    END IF;
    IF EXISTS (SELECT 1 FROM public.tenant_credits WHERE tenant_id = v_tid AND created_at > v_s.created_at) THEN
        RAISE EXCEPTION 'LATER_ACTIVITY the tenant''s credit balance changed after the settlement';
    END IF;
    IF EXISTS (SELECT 1 FROM public.invoices WHERE tenant_id = v_tid AND created_at > v_s.created_at AND status::text <> 'cancelled') THEN
        RAISE EXCEPTION 'LATER_ACTIVITY an invoice was created for this tenant after the settlement';
    END IF;

    IF v_s.final_invoice_id IS NOT NULL THEN
        SELECT * INTO v_final FROM public.invoices WHERE id = v_s.final_invoice_id;
        IF FOUND AND (COALESCE(v_final.paid_amount, 0) > 0 OR EXISTS (
               SELECT 1 FROM public.invoice_payment_allocations WHERE invoice_id = v_final.id AND amount <> 0)) THEN
            RAISE EXCEPTION 'FINAL_INVOICE_HAS_PAYMENTS the final invoice % has received payments since the settlement', v_final.id;
        END IF;
    END IF;

    ---------------------------------------------------------------- reverse the credit payments on older invoices
    SELECT * INTO v_batch FROM public.payment_batches
    WHERE tenant_id = v_tid AND idempotency_key = 'settle:' || v_s.idempotency_key;
    IF FOUND THEN
        IF v_batch.voided_at IS NOT NULL THEN
            RAISE EXCEPTION 'BATCH_ALREADY_VOIDED settlement payment batch % was already voided', v_batch.id;
        END IF;
        FOR v_r IN
            SELECT invoice_id, SUM(amount) AS amt FROM public.invoice_payment_allocations
            WHERE payment_batch_id = v_batch.id AND reverses_allocation_id IS NULL AND amount > 0
            GROUP BY invoice_id
        LOOP
            SELECT * INTO v_inv FROM public.invoices WHERE id = v_r.invoice_id;
            v_new_paid := COALESCE(v_inv.paid_amount, 0) - v_r.amt;
            IF v_new_paid < 0 THEN
                RAISE EXCEPTION 'SETTLEMENT_VOID_WOULD_MAKE_NEGATIVE invoice % would go below zero paid (paid %, reversing %)',
                    v_inv.id, v_inv.paid_amount, v_r.amt;
            END IF;
            v_overrides := v_overrides || jsonb_build_object(v_inv.id::text, v_new_paid);
            v_touched := v_touched || v_inv.id;
        END LOOP;

        FOR v_alloc IN
            SELECT * FROM public.invoice_payment_allocations
            WHERE payment_batch_id = v_batch.id AND reverses_allocation_id IS NULL AND amount > 0 ORDER BY created_at, id
        LOOP
            INSERT INTO public.invoice_payment_allocations (
                payment_batch_id, trigger_invoice_id, invoice_id, amount, paid_at, slip_url, source,
                payment_method_id, payment_method_snapshot, reverses_allocation_id, reversed_at, reversal_reason)
            VALUES (v_alloc.payment_batch_id, v_alloc.trigger_invoice_id, v_alloc.invoice_id, -v_alloc.amount, v_alloc.paid_at,
                    v_alloc.slip_url, 'void', v_alloc.payment_method_id, v_alloc.payment_method_snapshot,
                    v_alloc.id, now(), v_reason);
        END LOOP;

        FOR v_r IN SELECT key AS iid, value::numeric AS np FROM jsonb_each_text(v_overrides) LOOP
            SELECT * INTO v_inv FROM public.invoices WHERE id = v_r.iid::uuid;
            v_new_status := v_inv.status;
            IF v_inv.status::text NOT IN ('cancelled', 'draft') THEN
                v_new_status := public.money_derive_invoice_status_cf(v_inv.id, v_inv.total_amount, v_r.np, v_inv.due_date, v_today, v_overrides);
            END IF;
            UPDATE public.invoices
            SET paid_amount = v_r.np,
                status = v_new_status,
                locked_late_fee_amount = CASE WHEN v_inv.status::text = 'paid' AND v_new_status::text <> 'paid'
                                              THEN NULL ELSE locked_late_fee_amount END,
                payment_history = COALESCE(payment_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                    'type', 'void', 'payment_batch_id', v_batch.id, 'reason', v_reason, 'voided_at', now(),
                    'settlement_id', v_id))
            WHERE id = v_inv.id;
            INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, payment_batch_id, room_id, before, after, reason, source)
            VALUES ('settlement.void_allocation', v_by, v_tid, v_inv.id, v_batch.id, v_s.room_id,
                    jsonb_build_object('paid_amount', v_inv.paid_amount, 'status', v_inv.status),
                    jsonb_build_object('paid_amount', v_r.np, 'status', v_new_status), v_reason, 'void_move_out_settlement');
        END LOOP;

        UPDATE public.payment_batches SET voided_at = now(), voided_by = v_by, void_reason = v_reason WHERE id = v_batch.id;
        v_downstream := public.money_rederive_downstream(v_touched, v_overrides, v_today, v_batch.id, v_by, v_tid, 'void_move_out_settlement');
    END IF;

    ---------------------------------------------------------------- reverse held-credit rows written by this settlement
    INSERT INTO public.tenant_credits (tenant_id, kind, bucket, amount, invoice_id, payment_batch_id, reason, actor, reverses_credit_id)
    SELECT c.tenant_id, 'reversal', c.bucket, -c.amount, c.invoice_id, c.payment_batch_id,
           'Settlement voided: ' || v_reason, v_by, c.id
    FROM public.tenant_credits c
    WHERE c.tenant_id = v_tid AND c.created_at = v_s.created_at AND c.kind IN ('applied_to_invoice', 'forfeited')
      AND NOT EXISTS (SELECT 1 FROM public.tenant_credits r WHERE r.reverses_credit_id = c.id);
    GET DIAGNOSTICS v_credit_rows = ROW_COUNT;

    ---------------------------------------------------------------- cancel the final invoice
    IF v_s.final_invoice_id IS NOT NULL AND v_final.id IS NOT NULL THEN
        UPDATE public.invoices SET status = 'cancelled' WHERE id = v_s.final_invoice_id AND status::text <> 'cancelled';
        INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, room_id, before, after, reason, source)
        VALUES ('settlement.void_final_invoice', v_by, v_tid, v_s.final_invoice_id, v_s.room_id,
                jsonb_build_object('status', v_final.status), jsonb_build_object('status', 'cancelled'), v_reason, 'void_move_out_settlement');
    END IF;

    ---------------------------------------------------------------- un-bill the late fees this settlement billed or voided
    -- Restore each source invoice to exactly what it was before the settlement (billed flag, frozen amount, waived total).
    -- Runs after the payment reversal above, which may have cleared a freeze, so these values are written last.
    FOR v_lfe IN SELECT value FROM jsonb_array_elements(COALESCE(v_s.settlement->'lateFees', '[]'::jsonb)) LOOP
        UPDATE public.invoices
        SET late_fee_billed_at = NULL,
            locked_late_fee_amount = NULLIF(v_lfe->>'prev_locked', '')::numeric,
            waived_late_fee_amount = COALESCE(NULLIF(v_lfe->>'prev_waived', '')::numeric, 0)
        WHERE id = (v_lfe->>'invoice_id')::uuid;
        INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, room_id, after, reason, source)
        VALUES ('settlement.void_late_fee', v_by, v_tid, (v_lfe->>'invoice_id')::uuid, v_s.room_id,
                jsonb_build_object('amount', (v_lfe->>'amount')::numeric, 'was_voided', (v_lfe->>'voided')::boolean),
                v_reason, 'void_move_out_settlement');
    END LOOP;

    ---------------------------------------------------------------- restore tenant, room, logs, request
    v_status_before := v_tb->'tenant'->>'status';
    v_room_before := NULLIF(v_tb->'tenant'->>'room_id', '')::uuid;

    UPDATE public.tenants
    SET status = v_status_before,
        room_id = v_room_before,
        move_out_date = NULLIF(v_tb->'tenant'->>'move_out_date', '')::date,
        forfeit_security_deposit = COALESCE((v_tb->'tenant'->>'forfeit_security_deposit')::boolean, false),
        updated_at = now()
    WHERE id = v_tid;
    UPDATE public.rooms SET status = COALESCE(v_tb->>'room_status', 'occupied') WHERE id = v_s.room_id;

    FOR v_log IN SELECT * FROM jsonb_array_elements(COALESCE(v_tb->'room_logs', '[]'::jsonb)) LOOP
        UPDATE public.room_tenant_logs
        SET move_out_date = NULLIF(v_log->>'move_out_date', '')::date, updated_at = now()
        WHERE id = (v_log->>'id')::uuid AND move_out_date IS NOT DISTINCT FROM v_settled_date;
        GET DIAGNOSTICS v_cnt = ROW_COUNT;
        IF v_cnt <> 1 THEN
            RAISE EXCEPTION 'TENANT_STATE_CHANGED room log % is no longer as the settlement left it', v_log->>'id';
        END IF;
    END LOOP;
    FOR v_req IN SELECT * FROM jsonb_array_elements(COALESCE(v_tb->'move_out_requests', '[]'::jsonb)) LOOP
        UPDATE public.move_out_requests
        SET status = v_req->>'status', actual_move_out_date = NULLIF(v_req->>'actual_move_out_date', '')::date, updated_at = now()
        WHERE id = (v_req->>'id')::uuid AND status = 'completed';
        GET DIAGNOSTICS v_cnt = ROW_COUNT;
        IF v_cnt <> 1 THEN
            RAISE EXCEPTION 'TENANT_STATE_CHANGED move-out request % is no longer as the settlement left it', v_req->>'id';
        END IF;
    END LOOP;

    UPDATE public.move_out_settlements SET voided_at = now(), voided_by = v_by, void_reason = v_reason WHERE id = v_id;

    INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, payment_batch_id, room_id, before, after, reason, source)
    VALUES ('settlement.void', v_by, v_tid, v_s.final_invoice_id, v_batch.id, v_s.room_id,
            jsonb_build_object('settlement_id', v_id, 'tenant_status', v_tenant.status, 'tenant_room_id', v_tenant.room_id),
            jsonb_build_object('tenant_status', v_status_before, 'tenant_room_id', v_room_before,
                               'credit_rows_reversed', v_credit_rows, 'reopened_invoice_ids', to_jsonb(v_touched),
                               'downstream_updated', to_jsonb(v_downstream)),
            v_reason, 'void_move_out_settlement');

    RETURN jsonb_build_object('voided', true, 'settlement_id', v_id, 'credit_rows_reversed', v_credit_rows,
                              'reopened_invoice_ids', to_jsonb(v_touched), 'downstream_updated', to_jsonb(v_downstream),
                              'final_invoice_id', v_s.final_invoice_id);
END;
$$;

-- 4. refund_due_vs_paid: REFUND DUE exists only for a tenant with a live (unvoided) move-out settlement.
--    The 0300 version counted any deposit/unapplied credit balance, so an active tenant (or one whose settlement was just
--    voided) showed a refund "due" and a payout button that record_refund_payout would refuse with NOT_SETTLED.
--    Same columns as before (CREATE OR REPLACE is allowed); needs move_out_settlements from 0600.
CREATE OR REPLACE VIEW public.refund_due_vs_paid WITH (security_invoker = true) AS
WITH due AS (
    SELECT c.tenant_id, SUM(c.amount) AS refundable_credit
    FROM public.tenant_credits c
    WHERE c.bucket IN ('deposit', 'unapplied') AND c.kind <> 'refunded'
      AND EXISTS (SELECT 1 FROM public.move_out_settlements s WHERE s.tenant_id = c.tenant_id AND s.voided_at IS NULL)
    GROUP BY c.tenant_id
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

-- Server-only: never callable through PostgREST /rpc with the public key.
REVOKE ALL ON FUNCTION public.record_refund_payout(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_refund_payout(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.void_refund_payout(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_refund_payout(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.void_move_out_settlement(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_move_out_settlement(jsonb) TO service_role;

-- Rollback (restore from backup if rows already exist; the view reverts by re-running its definition from 0300):
--   DROP FUNCTION public.record_refund_payout(jsonb);
--   DROP FUNCTION public.void_refund_payout(jsonb);
--   DROP FUNCTION public.void_move_out_settlement(jsonb);
