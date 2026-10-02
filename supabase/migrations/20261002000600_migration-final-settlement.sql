-- Atomic, idempotent final move-out settlement
--
-- ADDITIVE ONLY: one new table (+ guard trigger) and one new function. No
-- existing table, column or row is changed by this migration. NOT applied
-- automatically: run it deliberately in the Supabase SQL editor.
-- Requires 20261002000000 (money_events), 20261002000200 (tenant_credits).
--
-- Rollback (in this order):
--   DROP FUNCTION IF EXISTS public.final_settle_move_out(jsonb);
--   DROP TRIGGER IF EXISTS trg_move_out_settlements_guard ON public.move_out_settlements;
--   DROP TABLE IF EXISTS public.move_out_settlements;
--   DROP FUNCTION IF EXISTS public.move_out_settlements_guard();
--   (tenant_credits / payment_batches / money_events rows written by the function
--    are append-only records; post reversals rather than deleting them.)
--
-- Why: final_move_out used to be a chain of separate writes (invoice, tenant,
-- room, logs, requests). A failure part-way left a tenant half-settled, and a
-- retried request settled the tenant twice. It also pooled advance rent with the
-- deposit, so leftover advance rent read as a refund. This function does every
-- write in ONE transaction:
--   1. replay: a repeated (tenant_id, idempotency_key) returns the original result
--   2. refuse a second live settlement of the same tenant
--   3. lock tenant -> room -> invoices (by id) in that fixed order
--   4. validate the caller's plan (lib/money/settlement.ts planMoveOutSettlement):
--      held balances, bucket identities, refund rule, forfeiture reason, every
--      open invoice accounted for, final invoice columns == engine columns
--   5. insert the final invoice (optional: abandon_room settles debt only)
--   6. credit that pays OLDER debt is recorded as a payment-like, NON-CASH
--      receipt (payment_batches + invoice_payment_allocations, source 'credit' or
--      'abandon_room', snapshot type 'credit') so cash reports can exclude it
--   7. tenant_credits: opening balances (if the ledger had none), applied_to_invoice
--      per bucket per invoice, forfeited deposit (reason REQUIRED), absorbed
--      advance rent (advance rent is NOT refundable - owner decision 2026-10-03)
--   8. the settlement row (snapshot of the planner output)
--   9. ONLY THEN: tenant inactive + room_id cleared, room freed, logs, requests
--  10. money_events for every change
-- Any failure rolls everything back: the room stays occupied and nothing is written.
--
-- A refund due is NOT a payout. This function never writes refund_payouts; the
-- refundable remainder (deposit left + unapplied credit left) simply stays in the
-- tenant_credits ledger, which is what refund_due_vs_paid reads.
--
-- Input shape (p):
--  { tenant_id, room_id, idempotency_key, move_out_date (date), created_by,
--    paid_at (timestamptz, for the credit receipt), source ('credit'|'abandon_room'),
--    advance_absorb_reason (text, optional; default explains the policy),
--    settlement: <planMoveOutSettlement output>,
--    debts: [{ invoice_id, expected_paid_amount }]   -- one per settlement.debtPayments
--    invoice: null | { id, start_date, end_date, issue_date, due_date, status,
--                      rent_amount, water_bill, electricity_bill, common_fee,
--                      late_fee_amount, additional_fees_total, carry_forward_amount,
--                      discount_amount, total_amount, additional_fees_breakdown,
--                      electricity_reading_start/end, water_reading_start/end, notes },
--    charges: null | { rent, water, electricity, commonFee, nativeLateFee,
--                      lateFeeItems, fees, carryForward, discount } }

CREATE TABLE IF NOT EXISTS public.move_out_settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    room_id UUID,
    idempotency_key TEXT NOT NULL,
    settlement JSONB NOT NULL,
    final_invoice_id UUID,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    voided_at TIMESTAMPTZ,
    voided_by TEXT,
    void_reason TEXT,
    CONSTRAINT move_out_settlements_key_unique UNIQUE (tenant_id, idempotency_key),
    CONSTRAINT move_out_settlements_key_nonblank CHECK (btrim(idempotency_key) <> ''),
    CONSTRAINT move_out_settlements_void_consistent CHECK (
        (voided_at IS NULL AND void_reason IS NULL)
        OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND btrim(void_reason) <> '')
    )
);

-- A tenant can be settled once; only voiding the settlement frees the slot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_move_out_settlements_live_tenant
    ON public.move_out_settlements (tenant_id) WHERE voided_at IS NULL;

CREATE OR REPLACE FUNCTION public.move_out_settlements_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'move_out_settlements is append-only (void instead)';
    END IF;
    IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL THEN
        RAISE EXCEPTION 'move_out_settlements: only a single void is allowed';
    END IF;
    IF (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason')
       IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason') THEN
        RAISE EXCEPTION 'move_out_settlements: only void columns may change';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_move_out_settlements_guard ON public.move_out_settlements;
CREATE TRIGGER trg_move_out_settlements_guard
    BEFORE UPDATE OR DELETE ON public.move_out_settlements
    FOR EACH ROW EXECUTE FUNCTION public.move_out_settlements_guard();

ALTER TABLE public.move_out_settlements ENABLE ROW LEVEL SECURITY;  -- service role only

CREATE OR REPLACE FUNCTION public.final_settle_move_out(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_tenant uuid := NULLIF(p->>'tenant_id', '')::uuid;
    v_room uuid := NULLIF(p->>'room_id', '')::uuid;
    v_key text := NULLIF(btrim(COALESCE(p->>'idempotency_key', '')), '');
    v_date date := COALESCE(NULLIF(p->>'move_out_date', '')::date, current_date);
    v_by text := p->>'created_by';
    v_paid_at timestamptz := COALESCE(NULLIF(p->>'paid_at', '')::timestamptz, now());
    v_source text := COALESCE(NULLIF(p->>'source', ''), 'credit');
    v_s jsonb := p->'settlement';
    v_inv jsonb := p->'invoice';
    v_ch jsonb := p->'charges';
    v_inv_id uuid;
    v_tenant_row public.tenants%ROWTYPE;
    v_existing public.move_out_settlements%ROWTYPE;
    v_settlement_id uuid := gen_random_uuid();
    v_batch_id uuid;
    v_trigger_inv uuid;
    v_snapshot jsonb := jsonb_build_object('type', 'credit', 'label', 'หักเครดิตตอนย้ายออก (เงินล่วงหน้า/เงินประกัน)');
    -- plan figures
    s_adv_held numeric; s_adv_app numeric; s_adv_abs numeric;
    s_dep_held numeric; s_dep_forf numeric; s_dep_app numeric; s_dep_rem numeric;
    s_un_held numeric; s_un_app numeric; s_un_rem numeric;
    s_final_bill numeric; s_final_paid numeric; s_refund numeric; s_debt_paid numeric;
    v_forfeit_reason text; v_absorb_reason text;
    -- ledger
    v_cnt int; v_bal numeric; v_col numeric;
    v_open_dep boolean := false; v_open_adv boolean := false;
    -- loops
    v_d jsonb; v_row public.invoices%ROWTYPE; v_amt numeric; v_expected numeric;
    v_new_paid numeric; v_new_status public.invoice_status; v_own numeric;
    v_ord bigint;
    v_rem_adv numeric; v_rem_dep numeric; v_rem_un numeric; v_take numeric;
    v_target record;
    v_engine_total numeric;
    v_unaccounted int;
    v_room_freed boolean := false;
BEGIN
    ---------------------------------------------------------------- shape
    IF v_tenant IS NULL OR v_room IS NULL THEN
        RAISE EXCEPTION 'tenant_id and room_id are required';
    END IF;
    IF v_key IS NULL OR v_key ~ '^\s*$' THEN
        RAISE EXCEPTION 'idempotency_key is required';
    END IF;
    IF v_s IS NULL OR jsonb_typeof(v_s) <> 'object' THEN
        RAISE EXCEPTION 'settlement snapshot is required';
    END IF;
    IF v_source NOT IN ('credit', 'abandon_room') THEN
        RAISE EXCEPTION 'source must be credit or abandon_room';
    END IF;

    ---------------------------------------------------------------- lock tenant, replay
    -- Serialise everything for this tenant; a racing duplicate waits here and
    -- then takes the replay branch below.
    SELECT * INTO v_tenant_row FROM public.tenants WHERE id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'tenant % not found', v_tenant;
    END IF;

    SELECT * INTO v_existing FROM public.move_out_settlements
    WHERE tenant_id = v_tenant AND idempotency_key = v_key;
    IF FOUND THEN
        RETURN jsonb_build_object('replayed', true, 'settlement_id', v_existing.id,
                                  'final_invoice_id', v_existing.final_invoice_id,
                                  'settlement', v_existing.settlement);
    END IF;

    IF EXISTS (SELECT 1 FROM public.move_out_settlements WHERE tenant_id = v_tenant AND voided_at IS NULL) THEN
        RAISE EXCEPTION 'ALREADY_SETTLED: tenant % already has a final settlement', v_tenant;
    END IF;

    -- The vacate step leaves room_id set on purpose; a mismatch means the caller
    -- is settling against the wrong room (or the tenant was already cleared).
    IF v_tenant_row.room_id IS DISTINCT FROM v_room THEN
        RAISE EXCEPTION 'ROOM_MISMATCH: tenant is not assigned to room %', v_room;
    END IF;
    PERFORM 1 FROM public.rooms WHERE id = v_room FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'room % not found', v_room;
    END IF;

    ---------------------------------------------------------------- plan figures
    IF jsonb_array_length(COALESCE(v_s->'errors', '[]'::jsonb)) > 0 THEN
        RAISE EXCEPTION 'PLAN_HAS_ERRORS: %', v_s->'errors';
    END IF;
    s_adv_held  := round(COALESCE((v_s->>'advanceRentHeld')::numeric, 0), 2);
    s_adv_app   := round(COALESCE((v_s->>'advanceRentApplied')::numeric, 0), 2);
    s_adv_abs   := round(COALESCE((v_s->>'advanceRentAbsorbed')::numeric, 0), 2);
    s_dep_held  := round(COALESCE((v_s->>'depositHeld')::numeric, 0), 2);
    s_dep_forf  := round(COALESCE((v_s->>'depositForfeited')::numeric, 0), 2);
    s_dep_app   := round(COALESCE((v_s->>'depositApplied')::numeric, 0), 2);
    s_dep_rem   := round(COALESCE((v_s->>'depositRemaining')::numeric, 0), 2);
    s_un_held   := round(COALESCE((v_s->>'unappliedCreditHeld')::numeric, 0), 2);
    s_un_app    := round(COALESCE((v_s->>'unappliedCreditApplied')::numeric, 0), 2);
    s_un_rem    := round(COALESCE((v_s->>'unappliedCreditRemaining')::numeric, 0), 2);
    s_final_bill := round(COALESCE((v_s->>'finalBillTotal')::numeric, 0), 2);
    s_final_paid := round(COALESCE((v_s->>'finalBillPaidFromCredit')::numeric, 0), 2);
    s_refund    := round(COALESCE((v_s->>'refundDue')::numeric, 0), 2);
    -- Blank means blank: '^\s*$' also catches tab/newline-only text, which
    -- btrim() (spaces only) lets through elsewhere.
    v_forfeit_reason := CASE WHEN COALESCE(v_s->>'forfeitReason', '') ~ '^\s*$' THEN NULL
                             ELSE btrim(v_s->>'forfeitReason', E' \t\r\n') END;
    v_absorb_reason := COALESCE(CASE WHEN COALESCE(p->>'advance_absorb_reason', '') ~ '^\s*$' THEN NULL
                                     ELSE btrim(p->>'advance_absorb_reason', E' \t\r\n') END,
        'ค่าเช่าล่วงหน้าไม่คืน (นโยบายเจ้าของ 2026-10-03): ส่วนที่เหลือหลังหักค่าใช้จ่ายถูกริบ');

    IF LEAST(s_adv_held, s_adv_app, s_adv_abs, s_dep_held, s_dep_forf, s_dep_app, s_dep_rem,
             s_un_held, s_un_app, s_un_rem, s_final_bill, s_final_paid, s_refund) < 0 THEN
        RAISE EXCEPTION 'PLAN_INVALID: negative amount in settlement';
    END IF;
    IF s_adv_app + s_adv_abs <> s_adv_held THEN
        RAISE EXCEPTION 'PLAN_INVALID: advance applied + absorbed <> advance held';
    END IF;
    IF s_dep_app + s_dep_forf + s_dep_rem <> s_dep_held THEN
        RAISE EXCEPTION 'PLAN_INVALID: deposit applied + forfeited + remaining <> deposit held';
    END IF;
    IF s_un_app + s_un_rem <> s_un_held THEN
        RAISE EXCEPTION 'PLAN_INVALID: unapplied applied + remaining <> unapplied held';
    END IF;
    -- Advance rent is never refundable: refund due is deposit + unapplied credit only.
    IF s_refund <> s_dep_rem + s_un_rem THEN
        RAISE EXCEPTION 'PLAN_INVALID: refund due must equal deposit remaining + unapplied remaining (advance rent is not refundable)';
    END IF;
    IF s_dep_forf > 0 AND v_forfeit_reason IS NULL THEN
        RAISE EXCEPTION 'FORFEIT_REASON_REQUIRED: a reason is required when forfeiting deposit';
    END IF;
    IF s_final_paid > s_final_bill THEN
        RAISE EXCEPTION 'PLAN_INVALID: credit on final bill exceeds the final bill';
    END IF;

    SELECT COALESCE(round(SUM((d->>'paidFromCredit')::numeric), 2), 0) INTO s_debt_paid
    FROM jsonb_array_elements(COALESCE(v_s->'debtPayments', '[]'::jsonb)) d;
    IF s_adv_app + s_dep_app + s_un_app <> s_debt_paid + s_final_paid THEN
        RAISE EXCEPTION 'PLAN_INVALID: credit drawn (%) <> credit applied to invoices (%)',
            s_adv_app + s_dep_app + s_un_app, s_debt_paid + s_final_paid;
    END IF;
    -- Credit left over (absorbed advance or refundable) is only possible when
    -- nothing is owed any more.
    IF (s_adv_abs > 0 OR s_refund > 0) AND (
           s_final_paid <> s_final_bill
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_s->'debtPayments', '[]'::jsonb)) d
                   WHERE (d->>'outstandingAfter')::numeric > 0)) THEN
        RAISE EXCEPTION 'PLAN_INVALID: credit left over while debt remains';
    END IF;

    ---------------------------------------------------------------- held balances
    -- The ledger is authoritative once it has rows for a bucket; before that the
    -- tenant columns are, and an opening-balance row is written so the ledger
    -- balances after this settlement.
    SELECT count(*), COALESCE(SUM(amount), 0) INTO v_cnt, v_bal
    FROM public.tenant_credits WHERE tenant_id = v_tenant AND bucket = 'deposit';
    v_col := round(COALESCE(v_tenant_row.security_deposit_amount, 0), 2);
    IF v_cnt = 0 THEN
        IF v_col <> s_dep_held THEN
            RAISE EXCEPTION 'HELD_MISMATCH: deposit held % <> tenant deposit %', s_dep_held, v_col;
        END IF;
        v_open_dep := v_col > 0;
    ELSIF v_bal <> s_dep_held THEN
        RAISE EXCEPTION 'HELD_MISMATCH: deposit held % <> ledger deposit balance %', s_dep_held, v_bal;
    END IF;

    SELECT count(*), COALESCE(SUM(amount), 0) INTO v_cnt, v_bal
    FROM public.tenant_credits WHERE tenant_id = v_tenant AND bucket = 'advance';
    v_col := round(COALESCE(v_tenant_row.advance_rent_amount, 0), 2);
    IF v_cnt = 0 THEN
        IF v_col <> s_adv_held THEN
            RAISE EXCEPTION 'HELD_MISMATCH: advance held % <> tenant advance rent %', s_adv_held, v_col;
        END IF;
        v_open_adv := v_col > 0;
    ELSIF v_bal <> s_adv_held THEN
        RAISE EXCEPTION 'HELD_MISMATCH: advance held % <> ledger advance balance %', s_adv_held, v_bal;
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_bal
    FROM public.tenant_credits WHERE tenant_id = v_tenant AND bucket = 'unapplied';
    IF v_bal <> s_un_held THEN
        RAISE EXCEPTION 'HELD_MISMATCH: unapplied credit held % <> ledger balance %', s_un_held, v_bal;
    END IF;

    ---------------------------------------------------------------- lock + check open invoices
    PERFORM 1 FROM public.invoices WHERE tenant_id = v_tenant ORDER BY id FOR UPDATE;

    IF EXISTS (SELECT 1 FROM public.invoices WHERE tenant_id = v_tenant AND status = 'verifying') THEN
        RAISE EXCEPTION 'VERIFYING_INVOICE: approve or reject the pending payment slip before settling';
    END IF;

    -- Every open invoice with money still owed must be in the plan, with the
    -- same own-outstanding the planner used. Otherwise a refund could be paid
    -- out while a debt was quietly left out.
    SELECT count(*) INTO v_unaccounted
    FROM public.invoices i
    WHERE i.tenant_id = v_tenant
      AND i.status IN ('draft', 'pending', 'partial', 'overdue')
      AND GREATEST(0, LEAST(COALESCE(i.total_amount, 0) - COALESCE(i.carry_forward_amount, 0),
                            COALESCE(i.total_amount, 0) - COALESCE(i.paid_amount, 0))) > 0
      AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(v_s->'debtPayments', '[]'::jsonb)) d
          WHERE (d->>'invoiceId')::uuid = i.id
            AND round((d->>'outstandingBefore')::numeric, 2) = round(GREATEST(0, LEAST(
                    COALESCE(i.total_amount, 0) - COALESCE(i.carry_forward_amount, 0),
                    COALESCE(i.total_amount, 0) - COALESCE(i.paid_amount, 0))), 2));
    IF v_unaccounted > 0 THEN
        RAISE EXCEPTION 'STALE_DEBTS: % open invoice(s) are missing from the plan or changed since it was made', v_unaccounted;
    END IF;

    ---------------------------------------------------------------- final invoice
    IF v_inv IS NOT NULL AND jsonb_typeof(v_inv) = 'object' THEN
        v_inv_id := NULLIF(v_inv->>'id', '')::uuid;
        IF v_inv_id IS NULL OR v_ch IS NULL OR jsonb_typeof(v_ch) <> 'object' THEN
            RAISE EXCEPTION 'invoice.id and charges are required with an invoice';
        END IF;
        -- Same formula as lib/invoice-total.ts computeInvoiceTotal / toInvoiceMoneyColumns.
        v_engine_total := round(
              COALESCE((v_ch->>'rent')::numeric, 0) + COALESCE((v_ch->>'water')::numeric, 0)
            + COALESCE((v_ch->>'electricity')::numeric, 0) + COALESCE((v_ch->>'commonFee')::numeric, 0)
            + COALESCE((v_ch->>'nativeLateFee')::numeric, 0) + COALESCE((v_ch->>'lateFeeItems')::numeric, 0)
            + COALESCE((v_ch->>'fees')::numeric, 0) + COALESCE((v_ch->>'carryForward')::numeric, 0)
            - COALESCE((v_ch->>'discount')::numeric, 0), 2);
        IF round((v_inv->>'total_amount')::numeric, 2) IS DISTINCT FROM v_engine_total
           OR round((v_inv->>'late_fee_amount')::numeric, 2) IS DISTINCT FROM
              round(COALESCE((v_ch->>'nativeLateFee')::numeric, 0) + COALESCE((v_ch->>'lateFeeItems')::numeric, 0), 2)
           OR round((v_inv->>'additional_fees_total')::numeric, 2) IS DISTINCT FROM
              round(COALESCE((v_ch->>'fees')::numeric, 0) + COALESCE((v_ch->>'lateFeeItems')::numeric, 0), 2)
           OR round((v_inv->>'carry_forward_amount')::numeric, 2) IS DISTINCT FROM round(COALESCE((v_ch->>'carryForward')::numeric, 0), 2)
           OR round((v_inv->>'discount_amount')::numeric, 2) IS DISTINCT FROM round(COALESCE((v_ch->>'discount')::numeric, 0), 2)
           OR round((v_inv->>'rent_amount')::numeric, 2) IS DISTINCT FROM round(COALESCE((v_ch->>'rent')::numeric, 0), 2)
           OR round((v_inv->>'water_bill')::numeric, 2) IS DISTINCT FROM round(COALESCE((v_ch->>'water')::numeric, 0), 2)
           OR round((v_inv->>'electricity_bill')::numeric, 2) IS DISTINCT FROM round(COALESCE((v_ch->>'electricity')::numeric, 0), 2)
           OR round((v_inv->>'common_fee')::numeric, 2) IS DISTINCT FROM round(COALESCE((v_ch->>'commonFee')::numeric, 0), 2) THEN
            RAISE EXCEPTION 'ENGINE_MISMATCH: invoice money columns do not equal the engine columns';
        END IF;
        -- The credit used on the final bill is shown as that invoice's discount.
        IF round(COALESCE((v_ch->>'discount')::numeric, 0), 2) <> s_final_paid THEN
            RAISE EXCEPTION 'PLAN_INVALID: final invoice discount (%) <> credit applied to final bill (%)',
                (v_ch->>'discount'), s_final_paid;
        END IF;
        IF v_engine_total + s_final_paid <> s_final_bill THEN
            RAISE EXCEPTION 'PLAN_INVALID: final invoice gross (%) <> plan final bill (%)', v_engine_total + s_final_paid, s_final_bill;
        END IF;
        IF v_engine_total < 0 THEN
            RAISE EXCEPTION 'final invoice total must not be negative';
        END IF;

        INSERT INTO public.invoices (
            id, tenant_id, room_id, status, start_date, end_date, issue_date, due_date,
            rent_amount, water_bill, electricity_bill, common_fee, discount_amount,
            late_fee_amount, carry_forward_amount, additional_fees_total,
            additional_fees_breakdown, total_amount, paid_amount,
            electricity_reading_start, electricity_reading_end,
            water_reading_start, water_reading_end, notes
        ) VALUES (
            v_inv_id, v_tenant, v_room,
            (CASE WHEN v_engine_total = 0 THEN 'paid' ELSE 'pending' END)::public.invoice_status,
            (v_inv->>'start_date')::date, (v_inv->>'end_date')::date,
            COALESCE(NULLIF(v_inv->>'issue_date', '')::date, current_date),
            (v_inv->>'due_date')::date,
            (v_inv->>'rent_amount')::numeric, (v_inv->>'water_bill')::numeric,
            (v_inv->>'electricity_bill')::numeric, (v_inv->>'common_fee')::numeric,
            (v_inv->>'discount_amount')::numeric, (v_inv->>'late_fee_amount')::numeric,
            (v_inv->>'carry_forward_amount')::numeric, (v_inv->>'additional_fees_total')::numeric,
            COALESCE(v_inv->'additional_fees_breakdown', '[]'::jsonb), v_engine_total, 0,
            NULLIF(v_inv->>'electricity_reading_start', '')::numeric,
            NULLIF(v_inv->>'electricity_reading_end', '')::numeric,
            NULLIF(v_inv->>'water_reading_start', '')::numeric,
            NULLIF(v_inv->>'water_reading_end', '')::numeric,
            v_inv->>'notes'
        );

        INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, room_id, after, source)
        VALUES ('settlement.final_invoice', v_by, v_tenant, v_inv_id, v_room,
                jsonb_build_object('total_amount', v_engine_total, 'discount_amount', s_final_paid,
                                   'final_bill', s_final_bill, 'charges', v_ch),
                'final_settle_move_out');
    ELSE
        IF s_final_bill <> 0 THEN
            RAISE EXCEPTION 'PLAN_INVALID: a final bill of % needs a final invoice', s_final_bill;
        END IF;
    END IF;

    ---------------------------------------------------------------- credit pays older debt (non-cash receipt)
    IF s_debt_paid > 0 THEN
        v_batch_id := gen_random_uuid();
        -- Trigger = the newest invoice the credit reached.
        SELECT (d->>'invoiceId')::uuid INTO v_trigger_inv
        FROM jsonb_array_elements(v_s->'debtPayments') WITH ORDINALITY AS t(d, ord)
        WHERE (d->>'paidFromCredit')::numeric > 0
        ORDER BY ord DESC LIMIT 1;

        INSERT INTO public.payment_batches (
            id, tenant_id, trigger_invoice_id, amount_received, amount_allocated, paid_at,
            mode, source, slip_url, payment_method_id, payment_method_snapshot,
            idempotency_key, created_by
        ) VALUES (
            v_batch_id, v_tenant, v_trigger_inv, s_debt_paid, s_debt_paid, v_paid_at,
            'credit', v_source, NULL, NULL, v_snapshot, 'settle:' || v_key, v_by
        );

        FOR v_d IN
            SELECT d FROM jsonb_array_elements(v_s->'debtPayments') WITH ORDINALITY AS t(d, ord)
            WHERE (d->>'paidFromCredit')::numeric > 0 ORDER BY ord
        LOOP
            v_amt := round((v_d->>'paidFromCredit')::numeric, 2);
            SELECT (x->>'expected_paid_amount')::numeric INTO v_expected
            FROM jsonb_array_elements(COALESCE(p->'debts', '[]'::jsonb)) x
            WHERE (x->>'invoice_id')::uuid = (v_d->>'invoiceId')::uuid;
            IF v_expected IS NULL THEN
                RAISE EXCEPTION 'debts[] has no expected_paid_amount for invoice %', v_d->>'invoiceId';
            END IF;

            SELECT * INTO v_row FROM public.invoices WHERE id = (v_d->>'invoiceId')::uuid;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'INVOICE_NOT_FOUND %', v_d->>'invoiceId';
            END IF;
            IF v_row.tenant_id <> v_tenant THEN
                RAISE EXCEPTION 'INVOICE_TENANT_MISMATCH: invoice % belongs to another tenant', v_row.id;
            END IF;
            IF v_row.status NOT IN ('draft', 'pending', 'partial', 'overdue') THEN
                RAISE EXCEPTION 'INVOICE_NOT_OPEN: invoice % is %', v_row.id, v_row.status;
            END IF;
            IF round(COALESCE(v_row.paid_amount, 0), 2) <> round(v_expected, 2) THEN
                RAISE EXCEPTION 'STALE_INVOICE % (paid_amount changed from % to %)', v_row.id, v_expected, v_row.paid_amount;
            END IF;
            v_new_paid := COALESCE(v_row.paid_amount, 0) + v_amt;
            IF v_new_paid > COALESCE(v_row.total_amount, 0) THEN
                RAISE EXCEPTION 'OVERPAY: credit % would exceed invoice % total', v_amt, v_row.id;
            END IF;
            v_own := GREATEST(0, LEAST(COALESCE(v_row.total_amount, 0) - COALESCE(v_row.carry_forward_amount, 0),
                                       COALESCE(v_row.total_amount, 0) - v_new_paid));
            v_new_status := CASE WHEN v_own = 0 THEN 'paid' ELSE 'partial' END;

            INSERT INTO public.invoice_payment_allocations (
                payment_batch_id, trigger_invoice_id, invoice_id, amount, paid_at, slip_url,
                source, payment_method_id, payment_method_snapshot
            ) VALUES (v_batch_id, v_trigger_inv, v_row.id, v_amt, v_paid_at, NULL, v_source, NULL, v_snapshot);

            UPDATE public.invoices SET
                paid_amount = v_new_paid,
                status = v_new_status,
                payment_history = COALESCE(payment_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                    'amount', v_amt, 'mode', 'credit', 'paid_at', v_paid_at, 'slip_url', NULL,
                    'created_at', now(), 'source', v_source, 'payment_batch_id', v_batch_id,
                    'trigger_invoice_id', v_trigger_inv, 'payment_method', v_snapshot,
                    'payment_method_id', NULL, 'idempotency_key', 'settle:' || v_key))
            WHERE id = v_row.id;

            INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, payment_batch_id, room_id, before, after, source)
            VALUES ('payment.allocate', v_by, v_tenant, v_row.id, v_batch_id, v_room,
                    jsonb_build_object('paid_amount', v_row.paid_amount, 'status', v_row.status),
                    jsonb_build_object('paid_amount', v_new_paid, 'status', v_new_status, 'allocated', v_amt),
                    'final_settle_move_out:' || v_source);
        END LOOP;

        INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, payment_batch_id, room_id, after, reason, source)
        VALUES ('payment.record', v_by, v_tenant, v_trigger_inv, v_batch_id, v_room,
                jsonb_build_object('amount_received', s_debt_paid, 'amount_allocated', s_debt_paid,
                                   'non_cash', true, 'mode', 'credit'),
                'Held credit applied to older debt at move-out (no money received)',
                'final_settle_move_out:' || v_source);
    END IF;

    ---------------------------------------------------------------- tenant_credits
    IF v_open_dep THEN
        INSERT INTO public.tenant_credits (tenant_id, kind, bucket, amount, reason, actor)
        VALUES (v_tenant, 'deposit_received', 'deposit', s_dep_held,
                'Opening balance from tenants.security_deposit_amount at move-out settlement', v_by);
        INSERT INTO public.money_events (action, actor_user_id, tenant_id, room_id, after, source)
        VALUES ('credit.opening_balance', v_by, v_tenant, v_room,
                jsonb_build_object('bucket', 'deposit', 'amount', s_dep_held), 'final_settle_move_out');
    END IF;
    IF v_open_adv THEN
        INSERT INTO public.tenant_credits (tenant_id, kind, bucket, amount, reason, actor)
        VALUES (v_tenant, 'advance_rent_received', 'advance', s_adv_held,
                'Opening balance from tenants.advance_rent_amount at move-out settlement', v_by);
        INSERT INTO public.money_events (action, actor_user_id, tenant_id, room_id, after, source)
        VALUES ('credit.opening_balance', v_by, v_tenant, v_room,
                jsonb_build_object('bucket', 'advance', 'amount', s_adv_held), 'final_settle_move_out');
    END IF;

    -- Draw buckets in the planner's order (advance, deposit, unapplied) across
    -- targets in the planner's order (older debts oldest-first, then the final bill).
    v_rem_adv := s_adv_app; v_rem_dep := s_dep_app; v_rem_un := s_un_app;
    FOR v_target IN
        SELECT (d->>'invoiceId')::uuid AS invoice_id, round((d->>'paidFromCredit')::numeric, 2) AS amount,
               v_batch_id AS batch_id, ord
        FROM jsonb_array_elements(COALESCE(v_s->'debtPayments', '[]'::jsonb)) WITH ORDINALITY AS t(d, ord)
        WHERE (d->>'paidFromCredit')::numeric > 0
        UNION ALL
        SELECT v_inv_id, s_final_paid, NULL::uuid, 1000000000 WHERE s_final_paid > 0
        ORDER BY ord
    LOOP
        v_amt := v_target.amount;
        v_take := LEAST(v_rem_adv, v_amt);
        IF v_take > 0 THEN
            INSERT INTO public.tenant_credits (tenant_id, kind, bucket, amount, invoice_id, payment_batch_id, actor)
            VALUES (v_tenant, 'applied_to_invoice', 'advance', -v_take, v_target.invoice_id, v_target.batch_id, v_by);
            INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, payment_batch_id, room_id, after, source)
            VALUES ('credit.apply', v_by, v_tenant, v_target.invoice_id, v_target.batch_id, v_room,
                    jsonb_build_object('bucket', 'advance', 'amount', v_take), 'final_settle_move_out');
            v_rem_adv := v_rem_adv - v_take; v_amt := v_amt - v_take;
        END IF;
        v_take := LEAST(v_rem_dep, v_amt);
        IF v_take > 0 THEN
            INSERT INTO public.tenant_credits (tenant_id, kind, bucket, amount, invoice_id, payment_batch_id, actor)
            VALUES (v_tenant, 'applied_to_invoice', 'deposit', -v_take, v_target.invoice_id, v_target.batch_id, v_by);
            INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, payment_batch_id, room_id, after, source)
            VALUES ('credit.apply', v_by, v_tenant, v_target.invoice_id, v_target.batch_id, v_room,
                    jsonb_build_object('bucket', 'deposit', 'amount', v_take), 'final_settle_move_out');
            v_rem_dep := v_rem_dep - v_take; v_amt := v_amt - v_take;
        END IF;
        v_take := LEAST(v_rem_un, v_amt);
        IF v_take > 0 THEN
            INSERT INTO public.tenant_credits (tenant_id, kind, bucket, amount, invoice_id, payment_batch_id, actor)
            VALUES (v_tenant, 'applied_to_invoice', 'unapplied', -v_take, v_target.invoice_id, v_target.batch_id, v_by);
            INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, payment_batch_id, room_id, after, source)
            VALUES ('credit.apply', v_by, v_tenant, v_target.invoice_id, v_target.batch_id, v_room,
                    jsonb_build_object('bucket', 'unapplied', 'amount', v_take), 'final_settle_move_out');
            v_rem_un := v_rem_un - v_take; v_amt := v_amt - v_take;
        END IF;
        IF v_amt <> 0 THEN
            RAISE EXCEPTION 'PLAN_INVALID: credit buckets do not cover invoice %', v_target.invoice_id;
        END IF;
    END LOOP;
    IF v_rem_adv <> 0 OR v_rem_dep <> 0 OR v_rem_un <> 0 THEN
        RAISE EXCEPTION 'PLAN_INVALID: credit drawn but not applied to any invoice';
    END IF;

    IF s_dep_forf > 0 THEN
        INSERT INTO public.tenant_credits (tenant_id, kind, bucket, amount, reason, actor)
        VALUES (v_tenant, 'forfeited', 'deposit', -s_dep_forf, v_forfeit_reason, v_by);
        INSERT INTO public.money_events (action, actor_user_id, tenant_id, room_id, after, reason, source)
        VALUES ('credit.forfeit', v_by, v_tenant, v_room,
                jsonb_build_object('bucket', 'deposit', 'amount', s_dep_forf, 'detail', v_s->>'forfeitDetail'),
                v_forfeit_reason, 'final_settle_move_out');
    END IF;
    IF s_adv_abs > 0 THEN
        INSERT INTO public.tenant_credits (tenant_id, kind, bucket, amount, reason, actor)
        VALUES (v_tenant, 'forfeited', 'advance', -s_adv_abs, v_absorb_reason, v_by);
        INSERT INTO public.money_events (action, actor_user_id, tenant_id, room_id, after, reason, source)
        VALUES ('credit.absorb_advance', v_by, v_tenant, v_room,
                jsonb_build_object('bucket', 'advance', 'amount', s_adv_abs), v_absorb_reason, 'final_settle_move_out');
    END IF;

    ---------------------------------------------------------------- settlement record
    INSERT INTO public.move_out_settlements (id, tenant_id, room_id, idempotency_key, settlement,
                                             final_invoice_id, created_by)
    VALUES (v_settlement_id, v_tenant, v_room, v_key, v_s, v_inv_id, v_by);

    INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, payment_batch_id, room_id, after, source)
    VALUES ('settlement.create', v_by, v_tenant, v_inv_id, v_batch_id, v_room,
            jsonb_build_object('settlement_id', v_settlement_id, 'refund_due', s_refund,
                               'advance_absorbed', s_adv_abs, 'deposit_forfeited', s_dep_forf,
                               'balance_still_owed', v_s->'balanceStillOwed', 'source', v_source),
            'final_settle_move_out');

    ---------------------------------------------------------------- only now release tenant and room
    UPDATE public.tenants
    SET status = 'inactive',
        room_id = NULL,
        move_out_date = v_date,
        forfeit_security_deposit = (s_dep_forf > 0),
        updated_at = now()
    WHERE id = v_tenant;

    UPDATE public.room_tenant_logs
    SET move_out_date = v_date, updated_at = now()
    WHERE room_id = v_room AND tenant_id = v_tenant AND move_out_date IS NULL;

    -- The vacate step may already have let a new tenant in; do not mark an
    -- occupied room available.
    IF NOT EXISTS (SELECT 1 FROM public.tenants
                   WHERE room_id = v_room AND status = 'active' AND id <> v_tenant) THEN
        UPDATE public.rooms SET status = 'available' WHERE id = v_room;
        v_room_freed := true;
    END IF;

    INSERT INTO public.room_logs (room_id, event_type, created_at) VALUES (v_room, 'move_out', now());

    UPDATE public.move_out_requests
    SET status = 'completed', updated_at = now(), actual_move_out_date = v_date
    WHERE tenant_id = v_tenant AND status IN ('requested', 'approved');

    INSERT INTO public.money_events (action, actor_user_id, tenant_id, room_id, before, after, source)
    VALUES ('tenant.move_out_settled', v_by, v_tenant, v_room,
            jsonb_build_object('status', v_tenant_row.status, 'room_id', v_tenant_row.room_id),
            jsonb_build_object('status', 'inactive', 'room_id', NULL, 'move_out_date', v_date,
                               'room_freed', v_room_freed),
            'final_settle_move_out');

    RETURN jsonb_build_object('replayed', false, 'settlement_id', v_settlement_id,
                              'final_invoice_id', v_inv_id, 'payment_batch_id', v_batch_id,
                              'settlement', v_s);
END;
$$;

COMMENT ON FUNCTION public.final_settle_move_out IS
    'Atomic, idempotent final move-out settlement: final invoice, non-cash credit receipt for older debt, tenant_credits (apply/forfeit/absorb advance), settlement row, then frees tenant and room. Never writes refund_payouts.';
