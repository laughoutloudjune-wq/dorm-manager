-- Rollback-wrapped tests: move-out settlement re-derives downstream carry-forward targets
-- in the SAME transaction as the credit payments it makes (finding 185).
-- Run ONLY on the dummy project dorm-test (rghxelkifdrpvabyxopb). Never on production.
-- Nothing persists: the block ends with RAISE EXCEPTION 'RESULT: ...'.
--
-- M1 credit pays an older invoice -> its target settles in the same call
-- M2 multi-invoice chain A -> B -> C settles recursively
-- M3 a downstream failure (target owned by another tenant) rolls the WHOLE settlement back
-- M4 the downstream step writes audit events tied to the settlement's payment batch

CREATE OR REPLACE FUNCTION pg_temp.ni(p_tenant uuid, p_room uuid, p_total numeric, p_carry numeric,
                                      p_paid numeric, p_status text, p_due date)
RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO public.invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date,
                              total_amount, carry_forward_amount, paid_amount, status)
  VALUES (p_tenant, p_room, current_date, p_due, current_date, current_date,
          p_total, p_carry, p_paid, p_status::public.invoice_status) RETURNING id
$f$;

CREATE OR REPLACE FUNCTION pg_temp.st(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT paid_amount::numeric(12,2) || '/' || status FROM public.invoices WHERE id = p_id
$f$;

CREATE OR REPLACE FUNCTION pg_temp.try_settle(p jsonb) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN RETURN 'OK:' || public.final_settle_move_out(p)::text;
EXCEPTION WHEN OTHERS THEN RETURN 'ERR:' || SQLERRM; END $f$;

CREATE OR REPLACE FUNCTION pg_temp.plan(adv_held numeric, adv_app numeric, adv_abs numeric,
  dep_held numeric, dep_forf numeric, dep_app numeric, dep_rem numeric,
  final_bill numeric, final_paid numeric, refund numeric, debts jsonb)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('advanceRentHeld', adv_held, 'advanceRentApplied', adv_app, 'advanceRentAbsorbed', adv_abs,
    'depositHeld', dep_held, 'depositForfeited', dep_forf, 'depositApplied', dep_app, 'depositRemaining', dep_rem,
    'forfeitReason', NULL, 'unappliedCreditHeld', 0, 'unappliedCreditApplied', 0, 'unappliedCreditRemaining', 0,
    'finalBillTotal', final_bill, 'finalBillPaidFromCredit', final_paid, 'finalBillDue', final_bill - final_paid,
    'debtPayments', debts, 'refundDue', refund, 'balanceStillOwed', 0, 'errors', '[]'::jsonb)
$f$;

CREATE OR REPLACE FUNCTION pg_temp.payload(tenant uuid, room uuid, k text, settlement jsonb, debts jsonb, fees numeric, discount numeric)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('tenant_id', tenant, 'room_id', room, 'idempotency_key', k, 'move_out_date', '2026-09-28',
    'created_by', 'tester', 'paid_at', '2026-09-28T10:00:00+07:00', 'source', 'credit', 'settlement', settlement, 'debts', debts,
    'invoice', jsonb_build_object('id', gen_random_uuid(), 'start_date', '2026-09-25', 'end_date', '2026-09-28',
      'issue_date', '2026-09-28', 'due_date', '2026-10-05', 'rent_amount', 0, 'water_bill', 0, 'electricity_bill', 0,
      'common_fee', 0, 'late_fee_amount', 0, 'additional_fees_total', fees, 'carry_forward_amount', 0,
      'discount_amount', discount, 'total_amount', fees - discount,
      'discount_breakdown', CASE WHEN discount > 0 THEN jsonb_build_array(jsonb_build_object('source','move_out_credit','label','credit','amount',discount)) ELSE '[]'::jsonb END,
      'additional_fees_breakdown', jsonb_build_array(jsonb_build_object('item_type','prorate_rent','label','prorate','amount',fees)),
      'notes', 'test'),
    'charges', jsonb_build_object('rent', 0, 'water', 0, 'electricity', 0, 'commonFee', 0, 'nativeLateFee', 0,
      'lateFeeItems', 0, 'fees', fees, 'carryForward', 0, 'discount', discount))
$f$;

-- plan: credit pays `debts` (older invoice(s)) and the 1,000 final bill; deposit 3,000 held
CREATE OR REPLACE FUNCTION pg_temp.settle_plan(p_debt_total numeric, p_debts jsonb)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT pg_temp.plan(0,0,0, 3000,0, p_debt_total + 1000, 3000 - p_debt_total - 1000, 1000,1000, 3000 - p_debt_total - 1000, p_debts)
$f$;

CREATE OR REPLACE FUNCTION pg_temp.debt(p_inv uuid, p_amount numeric) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('invoiceId', p_inv, 'periodStart', '2026-08-25', 'outstandingBefore', p_amount,
                            'paidFromCredit', p_amount, 'outstandingAfter', 0)
$f$;

DO $t$
DECLARE
  v_out text := '';
  v_room uuid; v_t uuid; v_other uuid; v_r text; v_res jsonb; v_n int; v_rows int; v_msg text;
  v_a uuid; v_b uuid; v_c uuid; v_x uuid; v_batch uuid;
  v_past date := '2026-09-05';
BEGIN
  ---------------------------------------------------------------- M1 / M4: one older invoice paid by credit settles its target
  INSERT INTO rooms(room_number, status) VALUES ('T-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id, status, security_deposit_amount, advance_rent_amount)
    VALUES ('Settle M1', '2026-01-01', v_room, 'active', 3000, 0) RETURNING id INTO v_t;
  v_a := pg_temp.ni(v_t, v_room, 1000, 0, 0, 'overdue', v_past);                -- older invoice, unpaid
  v_b := pg_temp.ni(v_t, v_room, 2500, 1000, 1500, 'partial', v_past);          -- target: own share paid, carries A's 1,000
  INSERT INTO invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_a, v_b, 1000);
  v_r := pg_temp.try_settle(pg_temp.payload(v_t, v_room, 'k-m1',
           pg_temp.settle_plan(1000, jsonb_build_array(pg_temp.debt(v_a, 1000))),
           jsonb_build_array(jsonb_build_object('invoice_id', v_a, 'expected_paid_amount', 0)), 1000, 1000));
  IF v_r LIKE 'OK:%' THEN v_res := substr(v_r, 4)::jsonb; v_batch := (v_res->>'payment_batch_id')::uuid; END IF;
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND pg_temp.st(v_a) = '1000.00/paid' AND pg_temp.st(v_b) = '1500.00/paid'
      AND (v_res->'downstream_updated') @> to_jsonb(v_b::text)
    THEN 'PASS  M1 credit pays the older invoice and its target settles in the same call (A '||pg_temp.st(v_a)||', B '||pg_temp.st(v_b)||', paid_amount of B untouched)'
    ELSE 'FAIL  M1 '||left(v_r,200)||' A='||pg_temp.st(v_a)||' B='||pg_temp.st(v_b) END;
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = v_t AND discount_amount = 1000
     AND discount_breakdown @> '[{"source":"move_out_credit","amount":1000}]'::jsonb;
  v_out := v_out || E'\n' || CASE WHEN v_n = 1 THEN 'PASS  M5 the final invoice stores the applied credit as a protected move_out_credit discount line'
    ELSE 'FAIL  M5 final invoices with the line='||v_n END;
  SELECT count(*) INTO v_n FROM money_events WHERE invoice_id = v_b AND action = 'invoice.status_rederive'
     AND payment_batch_id = v_batch AND source = 'final_settle_move_out';
  v_out := v_out || E'\n' || CASE WHEN v_n = 1 THEN 'PASS  M4 one invoice.status_rederive event, tied to the settlement payment batch'
    ELSE 'FAIL  M4 events='||v_n END;

  ---------------------------------------------------------------- M2 multi-invoice chain A -> B -> C
  INSERT INTO rooms(room_number, status) VALUES ('T-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id, status, security_deposit_amount, advance_rent_amount)
    VALUES ('Settle M2', '2026-01-01', v_room, 'active', 3000, 0) RETURNING id INTO v_t;
  v_a := pg_temp.ni(v_t, v_room, 1000, 0, 0, 'overdue', v_past);
  v_b := pg_temp.ni(v_t, v_room, 2500, 1000, 1500, 'partial', v_past);
  v_c := pg_temp.ni(v_t, v_room, 6000, 2500, 3500, 'partial', v_past);
  INSERT INTO invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_a, v_b, 1000), (v_b, v_c, 2500);
  v_r := pg_temp.try_settle(pg_temp.payload(v_t, v_room, 'k-m2',
           pg_temp.settle_plan(1000, jsonb_build_array(pg_temp.debt(v_a, 1000))),
           jsonb_build_array(jsonb_build_object('invoice_id', v_a, 'expected_paid_amount', 0)), 1000, 1000));
  IF v_r LIKE 'OK:%' THEN v_res := substr(v_r, 4)::jsonb; END IF;
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND pg_temp.st(v_a) = '1000.00/paid' AND pg_temp.st(v_b) = '1500.00/paid' AND pg_temp.st(v_c) = '3500.00/paid'
      AND (v_res->'downstream_updated') @> to_jsonb(v_b::text) AND (v_res->'downstream_updated') @> to_jsonb(v_c::text)
    THEN 'PASS  M2 chain A->B->C: paying A by credit settles B and (recursively) C ('||pg_temp.st(v_a)||', '||pg_temp.st(v_b)||', '||pg_temp.st(v_c)||')'
    ELSE 'FAIL  M2 '||left(v_r,200)||' A='||pg_temp.st(v_a)||' B='||pg_temp.st(v_b)||' C='||pg_temp.st(v_c) END;

  ---------------------------------------------------------------- M3 downstream failure rolls the whole settlement back
  INSERT INTO rooms(room_number, status) VALUES ('T-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id, status, security_deposit_amount, advance_rent_amount)
    VALUES ('Settle M3', '2026-01-01', v_room, 'active', 3000, 0) RETURNING id INTO v_t;
  INSERT INTO rooms(room_number) VALUES ('T-'||gen_random_uuid()) RETURNING id INTO v_other;
  INSERT INTO tenants(full_name, move_in_date, room_id, status) VALUES ('Other tenant', current_date, v_other, 'active') RETURNING id INTO v_x;
  v_a := pg_temp.ni(v_t, v_room, 1000, 0, 0, 'overdue', v_past);
  v_b := pg_temp.ni(v_x, v_other, 2500, 1000, 1500, 'partial', v_past);        -- target belongs to ANOTHER tenant
  INSERT INTO invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_a, v_b, 1000);
  v_r := pg_temp.try_settle(pg_temp.payload(v_t, v_room, 'k-m3',
           pg_temp.settle_plan(1000, jsonb_build_array(pg_temp.debt(v_a, 1000))),
           jsonb_build_array(jsonb_build_object('invoice_id', v_a, 'expected_paid_amount', 0)), 1000, 1000));
  SELECT count(*) INTO v_n FROM move_out_settlements WHERE tenant_id = v_t;
  SELECT count(*) INTO v_rows FROM (SELECT 1 FROM tenant_credits WHERE tenant_id = v_t UNION ALL
                                   SELECT 1 FROM payment_batches WHERE tenant_id = v_t UNION ALL
                                   SELECT 1 FROM money_events WHERE tenant_id = v_t) z;
  SELECT status||'/'||(room_id = v_room) INTO v_msg FROM tenants WHERE id = v_t;
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:CROSS_TENANT_CARRY%' AND v_n = 0 AND v_rows = 0 AND pg_temp.st(v_a) = '0.00/overdue'
      AND pg_temp.st(v_b) = '1500.00/partial' AND v_msg = 'active/true' AND (SELECT status FROM rooms WHERE id = v_room) = 'occupied'
    THEN 'PASS  M3 downstream failure rolled the whole settlement back: no settlement, credits, batch or events; debt unpaid; tenant active; room occupied ('||left(v_r,40)||'...)'
    ELSE 'FAIL  M3 '||left(v_r,120)||' settlements='||v_n||' rows='||v_rows||' A='||pg_temp.st(v_a)||' B='||pg_temp.st(v_b)||' tenant='||v_msg END;

  RAISE EXCEPTION 'RESULT:%', v_out;
END
$t$;
