-- Rollback-wrapped tests: late fees on the move-out final invoice (billed or voided by the admin).
-- Run ONLY on a dummy project (dorm-test / a disposable replay). Never on production.
-- Nothing persists: the block ends with RAISE EXCEPTION 'RESULT: ...'.
-- Requires: no late_fee_policies row exists (global-setting / legacy mode), migrations 0000-0800 incl. 0600 and 0650.
--
-- L1  all late fees billed on the final invoice
-- L2  one fee voided with a reason, the other billed
-- L3  every fee voided
-- L4  refusals (no late_fees at all, wrong amount, void without reason, fee listed twice, unknown invoice, total mismatch)
-- L5  a billed fee is never offered (or billed) again
-- L6  voiding the settlement un-bills / un-voids the fees exactly
-- L7  a frozen (locked) fee is billed at its frozen amount
-- L8  approval mode (a policy row exists): no candidates, settlement unaffected
-- L9  grants

CREATE OR REPLACE FUNCTION pg_temp.try(p_fn text, p jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  EXECUTE format('SELECT public.%I($1)', p_fn) INTO v USING p;
  RETURN 'OK:' || v::text;
EXCEPTION WHEN OTHERS THEN RETURN 'ERR:' || SQLERRM; END $f$;

-- Older invoice with a late fee rule: fee starts p_start, p_rate baht/day.
CREATE OR REPLACE FUNCTION pg_temp.ni_lf(p_tenant uuid, p_room uuid, p_total numeric, p_paid numeric, p_status text,
                                         p_start date, p_rate numeric, p_locked numeric DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO public.invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, carry_forward_amount,
                              paid_amount, status, late_fee_start_date, late_fee_per_day, locked_late_fee_amount)
  VALUES (p_tenant, p_room, current_date, p_start, current_date - 30, current_date - 1, p_total, 0, p_paid, p_status::public.invoice_status,
          p_start, p_rate, p_locked)
  RETURNING id
$f$;

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

-- Settlement payload whose final invoice carries p_lf_items of late fees (charges.lateFeeItems) and p_fees of other fees.
CREATE OR REPLACE FUNCTION pg_temp.payload_lf(tenant uuid, room uuid, k text, settlement jsonb, debts jsonb,
                                              p_fees numeric, p_lf_items numeric, discount numeric, late_fees jsonb)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('tenant_id', tenant, 'room_id', room, 'idempotency_key', k, 'move_out_date', '2026-09-28',
    'created_by', 'tester', 'paid_at', '2026-09-28T10:00:00+07:00', 'source', 'credit', 'settlement', settlement, 'debts', debts,
    'late_fees', late_fees,
    'invoice', jsonb_build_object('id', gen_random_uuid(), 'start_date', '2026-09-25', 'end_date', '2026-09-28',
      'issue_date', '2026-09-28', 'due_date', '2026-10-05', 'rent_amount', 0, 'water_bill', 0, 'electricity_bill', 0,
      'common_fee', 0, 'late_fee_amount', p_lf_items, 'additional_fees_total', p_fees + p_lf_items, 'carry_forward_amount', 0,
      'discount_amount', discount, 'total_amount', p_fees + p_lf_items - discount,
      'additional_fees_breakdown', jsonb_build_array(jsonb_build_object('item_type','late_fee_line','label','late fees','amount',p_lf_items)),
      'notes', 'test'),
    'charges', jsonb_build_object('rent', 0, 'water', 0, 'electricity', 0, 'commonFee', 0, 'nativeLateFee', 0,
      'lateFeeItems', p_lf_items, 'fees', p_fees, 'carryForward', 0, 'discount', discount))
$f$;

-- Tenant with deposit 3000; invoice A 1000 overdue (fee from 2026-09-06 at 10/day), invoice B 800 with 300 paid (fee from 2026-09-20 at 10/day).
-- As of 2026-09-28 (the date part of paid_at): A = 23 days = 230, B = 9 days = 90.
CREATE OR REPLACE FUNCTION pg_temp.mk_lf_tenant(p_key text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_room uuid; v_t uuid; v_a uuid; v_b uuid;
BEGIN
  INSERT INTO public.rooms(room_number, status) VALUES ('LF-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_room;
  INSERT INTO public.tenants(full_name, move_in_date, move_out_date, room_id, status, security_deposit_amount, advance_rent_amount)
    VALUES ('LateFee ' || p_key, '2026-01-01', '2026-09-30', v_room, 'active', 3000, 0) RETURNING id INTO v_t;
  INSERT INTO public.room_tenant_logs(room_id, tenant_id, tenant_name, move_in_date) VALUES (v_room, v_t, 'LF', '2026-01-01');
  v_a := pg_temp.ni_lf(v_t, v_room, 1000, 0, 'overdue', '2026-09-06', 10);
  v_b := pg_temp.ni_lf(v_t, v_room, 800, 300, 'partial', '2026-09-20', 10);
  RETURN jsonb_build_object('tenant', v_t, 'room', v_room, 'a', v_a, 'b', v_b);
END $f$;

-- Plan + debts for the two invoices (A owes 1000, B owes 500), final bill = lf_items, all paid from the deposit.
CREATE OR REPLACE FUNCTION pg_temp.plan_for(m jsonb, lf_items numeric) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT pg_temp.plan(0,0,0, 3000,0, lf_items + 1500, 3000 - lf_items - 1500, lf_items, lf_items, 3000 - lf_items - 1500,
    jsonb_build_array(
      jsonb_build_object('invoiceId', m->>'a', 'periodStart','2026-08-25','outstandingBefore',1000,'paidFromCredit',1000,'outstandingAfter',0),
      jsonb_build_object('invoiceId', m->>'b', 'periodStart','2026-09-01','outstandingBefore',500,'paidFromCredit',500,'outstandingAfter',0)))
$f$;
CREATE OR REPLACE FUNCTION pg_temp.debts_for(m jsonb) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_array(jsonb_build_object('invoice_id', m->>'a', 'expected_paid_amount', 0),
                           jsonb_build_object('invoice_id', m->>'b', 'expected_paid_amount', 300))
$f$;
CREATE OR REPLACE FUNCTION pg_temp.fee_json(p_inv text, p_amt numeric) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('invoice_id', p_inv, 'amount', p_amt) $f$;
CREATE OR REPLACE FUNCTION pg_temp.void_json(p_inv text, p_amt numeric, p_reason text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('invoice_id', p_inv, 'amount', p_amt, 'reason', p_reason) $f$;
CREATE OR REPLACE FUNCTION pg_temp.lfstate(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT (late_fee_billed_at IS NOT NULL)::text || '/locked=' || COALESCE(locked_late_fee_amount::text,'null') || '/waived=' || COALESCE(waived_late_fee_amount,0)::text
  FROM public.invoices WHERE id = p_id
$f$;

DO $t$
DECLARE
  v_out text := '';
  m jsonb; v_t uuid; v_a uuid; v_b uuid; v_c uuid; v_room uuid; v_r text; v_msg text; v_n int; v_fin uuid; v_set uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.late_fee_policies) THEN
    RAISE EXCEPTION 'RESULT:%', 'SKIPPED  a late_fee_policies row exists in this database (approval mode); these tests need legacy mode';
  END IF;

  ---------------------------------------------------------------- L1 all billed
  m := pg_temp.mk_lf_tenant('l1'); v_t := (m->>'tenant')::uuid; v_a := (m->>'a')::uuid; v_b := (m->>'b')::uuid; v_room := (m->>'room')::uuid;
  SELECT count(*) INTO v_n FROM public.move_out_late_fee_candidates(v_t, '2026-09-28');
  v_msg := 'candidates=' || v_n;
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload_lf(v_t, v_room, 'l1', pg_temp.plan_for(m, 320), pg_temp.debts_for(m), 0, 320, 320,
           jsonb_build_object('billed', jsonb_build_array(pg_temp.fee_json(v_a::text, 230), pg_temp.fee_json(v_b::text, 90)), 'voided', '[]'::jsonb)));
  IF v_r LIKE 'OK:%' THEN v_fin := (substr(v_r,4)::jsonb->>'final_invoice_id')::uuid; END IF;
  v_out := v_out || E'\n' || CASE WHEN v_n = 2 AND v_r LIKE 'OK:%'
      AND (SELECT late_fee_amount = 320 AND additional_fees_total = 320 AND discount_amount = 320 AND total_amount = 0 FROM invoices WHERE id = v_fin)
      AND pg_temp.lfstate(v_a) = 'true/locked=230.00/waived=0.00' AND pg_temp.lfstate(v_b) = 'true/locked=90.00/waived=0.00'
      AND (SELECT count(*) FROM money_events WHERE tenant_id = v_t AND action = 'settlement.late_fee_billed') = 2
      AND (SELECT jsonb_array_length(settlement->'lateFees') FROM move_out_settlements WHERE tenant_id = v_t) = 2
    THEN 'PASS  L1 two late fees (230 + 90 = 320) billed on the final invoice (late_fee_amount 320, total 0 after the 320 credit), both source invoices marked billed and frozen, 2 audit events'
    ELSE 'FAIL  L1 '||v_msg||' inv='||COALESCE((SELECT late_fee_amount||'/'||additional_fees_total||'/'||discount_amount||'/'||total_amount FROM invoices WHERE id = v_fin),'null')||' billedEvents='||(SELECT count(*) FROM money_events WHERE tenant_id = v_t AND action = 'settlement.late_fee_billed')||' lf='||COALESCE((SELECT jsonb_array_length(settlement->'lateFees') FROM move_out_settlements WHERE tenant_id = v_t)::text,'null')||' A='||COALESCE(pg_temp.lfstate(v_a),'-')||' B='||COALESCE(pg_temp.lfstate(v_b),'-') END;

  ---------------------------------------------------------------- L5 never billed again
  SELECT count(*) INTO v_n FROM public.move_out_late_fee_candidates(v_t, '2026-09-28');
  v_out := v_out || E'\n' || CASE WHEN v_n = 0 THEN 'PASS  L5 after settlement the billed fees are no longer offered (0 candidates), so they cannot be billed twice'
    ELSE 'FAIL  L5 candidates='||v_n END;

  ---------------------------------------------------------------- L6 void settlement restores exactly (same tenant)
  v_set := (SELECT id FROM move_out_settlements WHERE tenant_id = v_t AND voided_at IS NULL);
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  SELECT count(*) INTO v_n FROM public.move_out_late_fee_candidates(v_t, '2026-09-28');
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND v_n = 2
      AND pg_temp.lfstate(v_a) = 'false/locked=null/waived=0.00' AND pg_temp.lfstate(v_b) = 'false/locked=null/waived=0.00'
      AND (SELECT status FROM invoices WHERE id = v_fin) = 'cancelled'
      AND (SELECT count(*) FROM money_events WHERE tenant_id = v_t AND action = 'settlement.void_late_fee') = 2
    THEN 'PASS  L6 voiding the settlement un-bills both fees: billed flag cleared, frozen amounts and waived totals back to what they were, fees offered again, final invoice cancelled'
    ELSE 'FAIL  L6 '||left(v_r,100)||' cand='||v_n||' A='||pg_temp.lfstate(v_a)||' B='||pg_temp.lfstate(v_b) END;

  ---------------------------------------------------------------- L2 one voided with a reason
  m := pg_temp.mk_lf_tenant('l2'); v_t := (m->>'tenant')::uuid; v_a := (m->>'a')::uuid; v_b := (m->>'b')::uuid; v_room := (m->>'room')::uuid;
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload_lf(v_t, v_room, 'l2', pg_temp.plan_for(m, 90), pg_temp.debts_for(m), 0, 90, 90,
           jsonb_build_object('billed', jsonb_build_array(pg_temp.fee_json(v_b::text, 90)),
                              'voided', jsonb_build_array(pg_temp.void_json(v_a::text, 230, 'tenant disputed; goodwill')))));
  IF v_r LIKE 'OK:%' THEN v_fin := (substr(v_r,4)::jsonb->>'final_invoice_id')::uuid; END IF;
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%'
      AND (SELECT late_fee_amount||'/'||total_amount FROM invoices WHERE id = v_fin) = '90.00/0.00'
      AND pg_temp.lfstate(v_a) = 'true/locked=0.00/waived=230.00' AND pg_temp.lfstate(v_b) = 'true/locked=90.00/waived=0.00'
      AND (SELECT reason FROM money_events WHERE tenant_id = v_t AND action = 'settlement.late_fee_void') = 'tenant disputed; goodwill'
      AND (SELECT count(*) FROM money_events WHERE tenant_id = v_t AND action = 'settlement.late_fee_billed') = 1
    THEN 'PASS  L2 fee A (230) voided with a reason: not on the invoice, recorded as waived 230 and marked billed; fee B (90) billed; the void and its reason are in the audit log'
    ELSE 'FAIL  L2 '||left(v_r,160)||' A='||COALESCE(pg_temp.lfstate(v_a),'-')||' B='||COALESCE(pg_temp.lfstate(v_b),'-') END;
  -- and its void restores the voided one too
  v_set := (SELECT id FROM move_out_settlements WHERE tenant_id = v_t AND voided_at IS NULL);
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND pg_temp.lfstate(v_a) = 'false/locked=null/waived=0.00' AND pg_temp.lfstate(v_b) = 'false/locked=null/waived=0.00'
    THEN 'PASS  L6b voiding that settlement also restores the voided fee (waived back to 0, offered again)' ELSE 'FAIL  L6b '||left(v_r,100)||' A='||pg_temp.lfstate(v_a) END;

  ---------------------------------------------------------------- L3 all voided
  m := pg_temp.mk_lf_tenant('l3'); v_t := (m->>'tenant')::uuid; v_a := (m->>'a')::uuid; v_b := (m->>'b')::uuid; v_room := (m->>'room')::uuid;
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload_lf(v_t, v_room, 'l3', pg_temp.plan_for(m, 0), pg_temp.debts_for(m), 0, 0, 0,
           jsonb_build_object('billed', '[]'::jsonb,
                              'voided', jsonb_build_array(pg_temp.void_json(v_a::text, 230, 'waive all'), pg_temp.void_json(v_b::text, 90, 'waive all')))));
  IF v_r LIKE 'OK:%' THEN v_fin := (substr(v_r,4)::jsonb->>'final_invoice_id')::uuid; END IF;
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND (SELECT total_amount||'/'||late_fee_amount FROM invoices WHERE id = v_fin) = '0.00/0.00'
      AND pg_temp.lfstate(v_a) = 'true/locked=0.00/waived=230.00' AND pg_temp.lfstate(v_b) = 'true/locked=0.00/waived=90.00'
      AND (SELECT count(*) FROM public.move_out_late_fee_candidates(v_t, '2026-09-28')) = 0
    THEN 'PASS  L3 both fees voided: final invoice carries no late fee, both recorded as waived, nothing offered again'
    ELSE 'FAIL  L3 '||left(v_r,160) END;

  ---------------------------------------------------------------- L4 refusals (each must change nothing)
  v_msg := '';
  m := pg_temp.mk_lf_tenant('l4'); v_t := (m->>'tenant')::uuid; v_a := (m->>'a')::uuid; v_b := (m->>'b')::uuid; v_room := (m->>'room')::uuid;
  -- (a) caller says nothing about late fees although two are owed
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload_lf(v_t, v_room, 'l4a', pg_temp.plan_for(m, 0), pg_temp.debts_for(m), 0, 0, 0, NULL));
  IF v_r NOT LIKE 'ERR:LATE_FEE_MISMATCH%' THEN v_msg := v_msg || ' (a) ' || left(v_r,70); END IF;
  -- (b) wrong amount
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload_lf(v_t, v_room, 'l4b', pg_temp.plan_for(m, 319), pg_temp.debts_for(m), 0, 319, 319,
           jsonb_build_object('billed', jsonb_build_array(pg_temp.fee_json(v_a::text, 229), pg_temp.fee_json(v_b::text, 90)), 'voided', '[]'::jsonb)));
  IF v_r NOT LIKE 'ERR:LATE_FEE_MISMATCH%' THEN v_msg := v_msg || ' (b) ' || left(v_r,70); END IF;
  -- (c) void without a reason
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload_lf(v_t, v_room, 'l4c', pg_temp.plan_for(m, 90), pg_temp.debts_for(m), 0, 90, 90,
           jsonb_build_object('billed', jsonb_build_array(pg_temp.fee_json(v_b::text, 90)), 'voided', jsonb_build_array(pg_temp.void_json(v_a::text, 230, '   ')))));
  IF v_r NOT LIKE 'ERR:LATE_FEE_VOID_REASON_REQUIRED%' THEN v_msg := v_msg || ' (c) ' || left(v_r,70); END IF;
  -- (d) the same invoice both billed and voided
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload_lf(v_t, v_room, 'l4d', pg_temp.plan_for(m, 320), pg_temp.debts_for(m), 0, 320, 320,
           jsonb_build_object('billed', jsonb_build_array(pg_temp.fee_json(v_a::text, 230), pg_temp.fee_json(v_b::text, 90)),
                              'voided', jsonb_build_array(pg_temp.void_json(v_a::text, 230, 'dup')))));
  IF v_r NOT LIKE 'ERR:LATE_FEE_MISMATCH%' THEN v_msg := v_msg || ' (d) ' || left(v_r,70); END IF;
  -- (e) an invoice that owes no late fee listed as billed
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload_lf(v_t, v_room, 'l4e', pg_temp.plan_for(m, 420), pg_temp.debts_for(m), 0, 420, 420,
           jsonb_build_object('billed', jsonb_build_array(pg_temp.fee_json(v_a::text, 230), pg_temp.fee_json(v_b::text, 90), pg_temp.fee_json(gen_random_uuid()::text, 100)), 'voided', '[]'::jsonb)));
  IF v_r NOT LIKE 'ERR:LATE_FEE_MISMATCH%' THEN v_msg := v_msg || ' (e) ' || left(v_r,70); END IF;
  -- (f) late fees listed as billed but the invoice charges carry none
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload_lf(v_t, v_room, 'l4f', pg_temp.plan_for(m, 0), pg_temp.debts_for(m), 0, 0, 0,
           jsonb_build_object('billed', jsonb_build_array(pg_temp.fee_json(v_a::text, 230), pg_temp.fee_json(v_b::text, 90)), 'voided', '[]'::jsonb)));
  IF v_r NOT LIKE 'ERR:LATE_FEE_MISMATCH%' THEN v_msg := v_msg || ' (f) ' || left(v_r,70); END IF;
  IF (SELECT count(*) FROM move_out_settlements WHERE tenant_id = v_t) <> 0
     OR pg_temp.lfstate(v_a) <> 'false/locked=null/waived=0.00' OR pg_temp.lfstate(v_b) <> 'false/locked=null/waived=0.00' THEN v_msg := v_msg || ' state-changed'; END IF;
  v_out := v_out || E'\n' || CASE WHEN v_msg = '' THEN 'PASS  L4 refused with nothing changed: no late_fees, wrong amount, void without reason, same fee billed and voided, an unknown invoice, fees billed but not on the invoice'
    ELSE 'FAIL  L4 problems:'||v_msg END;

  ---------------------------------------------------------------- L7 frozen fee is billed at its frozen amount
  INSERT INTO public.rooms(room_number, status) VALUES ('LF-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_room;
  INSERT INTO public.tenants(full_name, move_in_date, move_out_date, room_id, status, security_deposit_amount, advance_rent_amount)
    VALUES ('LateFee l7', '2026-01-01', '2026-09-30', v_room, 'active', 3000, 0) RETURNING id INTO v_t;
  INSERT INTO public.room_tenant_logs(room_id, tenant_id, tenant_name, move_in_date) VALUES (v_room, v_t, 'LF', '2026-01-01');
  v_c := pg_temp.ni_lf(v_t, v_room, 500, 500, 'paid', '2026-09-01', 10, 150);
  SELECT amount::text || '/' || locked::text || '/' || COALESCE(days_overdue::text, 'null') INTO v_msg FROM public.move_out_late_fee_candidates(v_t, '2026-09-28');
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload_lf(v_t, v_room, 'l7',
           pg_temp.plan(0,0,0, 3000,0, 150, 2850, 150, 150, 2850, '[]'::jsonb), '[]'::jsonb, 0, 150, 150,
           jsonb_build_object('billed', jsonb_build_array(pg_temp.fee_json(v_c::text, 150)), 'voided', '[]'::jsonb)));
  v_out := v_out || E'\n' || CASE WHEN v_msg = '150.00/true/null' AND v_r LIKE 'OK:%' AND pg_temp.lfstate(v_c) = 'true/locked=150.00/waived=0.00'
    THEN 'PASS  L7 an invoice paid earlier with a frozen fee of 150 offers exactly 150 (no extra days counted), bills it, and stays frozen at 150'
    ELSE 'FAIL  L7 cand='||COALESCE(v_msg,'null')||' '||left(v_r,140)||' '||COALESCE(pg_temp.lfstate(v_c),'-') END;

  ---------------------------------------------------------------- L8 approval mode: a policy row exists -> no candidates, settlement unaffected
  INSERT INTO public.late_fee_policies(version, effective_from, rate_kind, rate_value) VALUES (990011, current_date, 'flat_per_day', 50);
  m := pg_temp.mk_lf_tenant('l8'); v_t := (m->>'tenant')::uuid; v_room := (m->>'room')::uuid;
  SELECT count(*) INTO v_n FROM public.move_out_late_fee_candidates(v_t, '2026-09-28');
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload_lf(v_t, v_room, 'l8', pg_temp.plan_for(m, 0), pg_temp.debts_for(m), 0, 0, 0, NULL));
  v_out := v_out || E'\n' || CASE WHEN v_n = 0 AND v_r LIKE 'OK:%'
    THEN 'PASS  L8 with a late-fee policy in force (approval mode) the move-out offers no late fees and settles without them'
    ELSE 'FAIL  L8 cand='||v_n||' '||left(v_r,140) END;

  ---------------------------------------------------------------- L9 grants
  SELECT string_agg(f, ',') INTO v_msg FROM (VALUES ('move_out_late_fee_candidates(uuid,date)')) q(f)
   WHERE has_function_privilege('anon', 'public.' || f, 'EXECUTE') OR has_function_privilege('authenticated', 'public.' || f, 'EXECUTE');
  v_out := v_out || E'\n' || CASE WHEN v_msg IS NULL AND has_function_privilege('service_role', 'public.move_out_late_fee_candidates(uuid,date)', 'EXECUTE')
    THEN 'PASS  L9 move_out_late_fee_candidates is executable by service_role only' ELSE 'FAIL  L9 '||COALESCE(v_msg,'service_role cannot execute') END;

  RAISE EXCEPTION 'RESULT:%', v_out;
END
$t$;
