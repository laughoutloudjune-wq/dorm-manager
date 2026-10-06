-- Rollback-wrapped tests for public.final_settle_move_out(jsonb)  (migration 20261002000600).
-- Run ONLY on the dummy project dorm-test (rghxelkifdrpvabyxopb). Never on production.
-- Nothing persists: the DO block ends with RAISE EXCEPTION 'RESULT: ...', which rolls back every
-- fixture row, the temporary failure trigger, and everything the function wrote.
-- Case statuses: PASS | FAIL.

-- Calls the function; returns 'OK:<result json>' or the error message. The function's own
-- exception block means a failed call leaves nothing behind (that is what F1 checks).
CREATE OR REPLACE FUNCTION pg_temp.try_settle(p jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  v := public.final_settle_move_out(p);
  RETURN 'OK:' || v::text;
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERR:' || SQLERRM;
END $f$;

-- Planner-shaped snapshot (same keys as lib/money/settlement.ts MoveOutSettlementPlan).
CREATE OR REPLACE FUNCTION pg_temp.plan(
  adv_held numeric, adv_app numeric, adv_abs numeric,
  dep_held numeric, dep_forf numeric, dep_app numeric, dep_rem numeric,
  final_bill numeric, final_paid numeric, refund numeric,
  debts jsonb, forfeit_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object(
    'advanceRentHeld', adv_held, 'advanceRentApplied', adv_app, 'advanceRentAbsorbed', adv_abs,
    'depositHeld', dep_held, 'depositForfeited', dep_forf, 'depositApplied', dep_app, 'depositRemaining', dep_rem,
    'forfeitReason', forfeit_reason,
    'unappliedCreditHeld', 0, 'unappliedCreditApplied', 0, 'unappliedCreditRemaining', 0,
    'finalBillTotal', final_bill, 'finalBillPaidFromCredit', final_paid, 'finalBillDue', final_bill - final_paid,
    'debtPayments', debts, 'refundDue', refund, 'balanceStillOwed', 0, 'errors', '[]'::jsonb)
$f$;

-- Final invoice + engine charges: prorated rent as a fee line, utilities, credit as discount.
CREATE OR REPLACE FUNCTION pg_temp.payload(
  tenant uuid, room uuid, k text, settlement jsonb, debts jsonb,
  fees numeric, water numeric, elec numeric, discount numeric, total_override numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object(
    'tenant_id', tenant, 'room_id', room, 'idempotency_key', k, 'move_out_date', '2026-09-28',
    'created_by', 'tester', 'paid_at', '2026-09-28T10:00:00+07:00', 'source', 'credit',
    'settlement', settlement, 'debts', debts,
    'invoice', jsonb_build_object('id', gen_random_uuid(), 'start_date', '2026-09-25', 'end_date', '2026-09-28',
        'issue_date', '2026-09-28', 'due_date', '2099-12-31', 'rent_amount', 0, 'water_bill', water,
        'electricity_bill', elec, 'common_fee', 0, 'late_fee_amount', 0, 'additional_fees_total', fees,
        'carry_forward_amount', 0, 'discount_amount', discount,
        'total_amount', COALESCE(total_override, fees + water + elec - discount),
        'additional_fees_breakdown', jsonb_build_array(jsonb_build_object('item_type','prorate_rent','label','prorate','amount',fees)),
        'notes', 'test'),
    'charges', jsonb_build_object('rent', 0, 'water', water, 'electricity', elec, 'commonFee', 0,
        'nativeLateFee', 0, 'lateFeeItems', 0, 'fees', fees, 'carryForward', 0, 'discount', discount))
$f$;

DO $t$
DECLARE
  v_out text := '';
  v_room uuid; v_t uuid; v_o1 uuid; v_r text; v_res jsonb; v_res2 jsonb;
  v_n int; v_n2 int; v_num numeric; v_msg text; v_st text; v_p jsonb; v_sid uuid;
  v_counts_before text; v_counts_after text;
BEGIN
  ---------------------------------------------------------------- S1 success: older debt + final bill, deposit refund due
  -- deposit 3000, advance 1000; older invoice 1500 owed; final bill 2000 prorate + 100 water + 300 elec = 2400.
  -- owed 3900: advance 1000 + deposit 2900 -> deposit remaining 100 = refund due.
  INSERT INTO rooms(room_number, status) VALUES ('T-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id, status, security_deposit_amount, advance_rent_amount)
    VALUES ('Settle S1', '2026-01-01', v_room, 'active', 3000, 1000) RETURNING id INTO v_t;
  INSERT INTO room_tenant_logs(room_id, tenant_id, tenant_name, move_in_date) VALUES (v_room, v_t, 'Settle S1', '2026-01-01');
  INSERT INTO move_out_requests(tenant_id, requested_move_out_date, status) VALUES (v_t, '2026-09-28', 'approved');
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_t, v_room, '2026-08-25', '2026-09-05', '2026-08-25', '2026-09-24', 1500, 'overdue') RETURNING id INTO v_o1;

  v_p := pg_temp.payload(v_t, v_room, 'k-s1',
    pg_temp.plan(1000,1000,0, 3000,0,2900,100, 2400,2400,100,
      jsonb_build_array(jsonb_build_object('invoiceId', v_o1, 'periodStart','2026-08-25','outstandingBefore',1500,'paidFromCredit',1500,'outstandingAfter',0))),
    jsonb_build_array(jsonb_build_object('invoice_id', v_o1, 'expected_paid_amount', 0)),
    2000, 100, 300, 2400);
  v_r := pg_temp.try_settle(v_p);
  IF v_r NOT LIKE 'OK:%' THEN
    v_out := v_out || E'\nFAIL  S1 success call failed: ' || v_r;
  ELSE
    v_res := substr(v_r, 4)::jsonb; v_sid := (v_res->>'settlement_id')::uuid;
    SELECT total_amount::numeric(12,2)||'/'||discount_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = (v_res->>'final_invoice_id')::uuid;
    v_msg := 'final='||v_st;
    SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_o1; v_msg := v_msg||' older='||v_st;
    SELECT count(*)||'/'||max(source)||'/'||max(mode)||'/'||sum(amount_received)::numeric(12,2)||'/'||max(payment_method_snapshot->>'type') INTO v_st
      FROM payment_batches WHERE tenant_id = v_t; v_msg := v_msg||' batch='||v_st;
    SELECT count(*)||'/'||sum(amount)::numeric(12,2) INTO v_st FROM invoice_payment_allocations WHERE invoice_id = v_o1; v_msg := v_msg||' alloc='||v_st;
    SELECT deposit_held::numeric(12,2)||'/'||advance_held::numeric(12,2)||'/'||unapplied_credit::numeric(12,2) INTO v_st FROM tenant_credit_balances WHERE tenant_id = v_t;
    v_msg := v_msg||' balances='||v_st;
    SELECT string_agg(kind||':'||bucket||':'||amount::numeric(12,2)||':'||CASE WHEN invoice_id = v_o1 THEN 'older' WHEN invoice_id IS NULL THEN '-' ELSE 'final' END, ',' ORDER BY kind COLLATE "C", bucket COLLATE "C", amount)
      INTO v_st FROM tenant_credits WHERE tenant_id = v_t; v_msg := v_msg||' credits='||v_st;
    SELECT status||'/'||COALESCE(room_id::text,'null')||'/'||move_out_date INTO v_st FROM tenants WHERE id = v_t; v_msg := v_msg||' tenant='||v_st;
    SELECT status INTO v_st FROM rooms WHERE id = v_room; v_msg := v_msg||' room='||v_st;
    SELECT count(*) INTO v_n FROM move_out_settlements WHERE tenant_id = v_t; v_msg := v_msg||' settlements='||v_n;
    SELECT COALESCE(move_out_date::text,'open') INTO v_st FROM room_tenant_logs WHERE tenant_id = v_t; v_msg := v_msg||' log='||v_st;
    SELECT status INTO v_st FROM move_out_requests WHERE tenant_id = v_t; v_msg := v_msg||' request='||v_st;
    v_out := v_out || E'\n' || CASE WHEN v_msg =
      'final=0.00/2400.00/paid older=1500.00/paid batch=1/credit/credit/1500.00/credit alloc=1/1500.00 balances=100.00/0.00/0.00'
      ||' credits=advance_rent_received:advance:1000.00:-,applied_to_invoice:advance:-1000.00:older,applied_to_invoice:deposit:-2400.00:final,applied_to_invoice:deposit:-500.00:older,deposit_received:deposit:3000.00:-'
      ||' tenant=inactive/null/2026-09-28 room=available settlements=1 log=2026-09-28 request=completed'
      THEN 'PASS  S1 success ('||v_msg||')' ELSE 'FAIL  S1 success ('||v_msg||')' END;

    SELECT string_agg(action||'x'||c, ',' ORDER BY action) INTO v_st FROM (SELECT action, count(*) c FROM money_events WHERE tenant_id = v_t GROUP BY action) q;
    v_out := v_out || E'\n' || CASE WHEN v_st =
      'credit.applyx3,credit.opening_balancex2,payment.allocatex1,payment.recordx1,settlement.createx1,settlement.final_invoicex1,tenant.move_out_settledx1'
      THEN 'PASS  S1b money_events for every change ('||v_st||')' ELSE 'FAIL  S1b money_events ('||v_st||')' END;

    -- S7 refund due recorded as DUE, not paid: refund_due_vs_paid shows it outstanding, no payout row exists.
    SELECT refund_due::numeric(12,2)||'/'||refund_paid::numeric(12,2)||'/'||refund_outstanding::numeric(12,2) INTO v_st FROM refund_due_vs_paid WHERE tenant_id = v_t;
    SELECT count(*) INTO v_n FROM refund_payouts WHERE tenant_id = v_t;
    v_out := v_out || E'\n' || CASE WHEN v_st = '100.00/0.00/100.00' AND v_n = 0
      THEN 'PASS  S7 deposit refund recorded as due, not paid (due/paid/outstanding='||v_st||', payouts='||v_n||')'
      ELSE 'FAIL  S7 refund due ('||COALESCE(v_st,'null')||', payouts='||v_n||')' END;

    ---------------------------------------------------------------- S2 replay with the same key
    SELECT count(*)::text||'/'||(SELECT count(*) FROM tenant_credits WHERE tenant_id=v_t)||'/'||(SELECT count(*) FROM money_events WHERE tenant_id=v_t)
           ||'/'||(SELECT count(*) FROM payment_batches WHERE tenant_id=v_t)
      INTO v_counts_before FROM invoices WHERE tenant_id = v_t;
    v_r := pg_temp.try_settle(v_p);
    SELECT count(*)::text||'/'||(SELECT count(*) FROM tenant_credits WHERE tenant_id=v_t)||'/'||(SELECT count(*) FROM money_events WHERE tenant_id=v_t)
           ||'/'||(SELECT count(*) FROM payment_batches WHERE tenant_id=v_t)
      INTO v_counts_after FROM invoices WHERE tenant_id = v_t;
    v_res2 := CASE WHEN v_r LIKE 'OK:%' THEN substr(v_r, 4)::jsonb END;
    v_out := v_out || E'\n' || CASE WHEN v_res2->>'replayed' = 'true' AND (v_res2->>'settlement_id')::uuid = v_sid
        AND v_res2->>'final_invoice_id' = v_res->>'final_invoice_id' AND v_counts_before = v_counts_after
      THEN 'PASS  S2 replay same key returns original, writes nothing (invoices/credits/events/batches '||v_counts_after||')'
      ELSE 'FAIL  S2 replay ('||v_r||' before='||v_counts_before||' after='||v_counts_after||')' END;

    ---------------------------------------------------------------- S3 second settlement with a different key
    v_r := pg_temp.try_settle(v_p || jsonb_build_object('idempotency_key', 'k-s1-other'));
    v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:ALREADY_SETTLED%'
      THEN 'PASS  S3 double settlement rejected ('||left(v_r, 60)||')' ELSE 'FAIL  S3 double settlement ('||v_r||')' END;
  END IF;

  ---------------------------------------------------------------- F1 forced failure at the last step rolls everything back
  INSERT INTO rooms(room_number, status) VALUES ('T-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id, status, security_deposit_amount, advance_rent_amount)
    VALUES ('Settle F1', '2026-01-01', v_room, 'active', 3000, 1000) RETURNING id INTO v_t;
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_t, v_room, '2026-08-25', '2026-09-05', '2026-08-25', '2026-09-24', 1500, 'overdue') RETURNING id INTO v_o1;
  -- The room update is the LAST write the function makes (after invoice, receipt, credits, settlement, tenant).
  CREATE FUNCTION public.zz_test_fail_room_update() RETURNS trigger LANGUAGE plpgsql AS $x$
    BEGIN RAISE EXCEPTION 'FORCED_TEST_FAILURE'; END $x$;
  EXECUTE format('CREATE TRIGGER zz_test_fail BEFORE UPDATE ON public.rooms FOR EACH ROW WHEN (OLD.id = %L::uuid) EXECUTE FUNCTION public.zz_test_fail_room_update()', v_room);
  v_r := pg_temp.try_settle(pg_temp.payload(v_t, v_room, 'k-f1',
    pg_temp.plan(1000,1000,0, 3000,0,2900,100, 2400,2400,100,
      jsonb_build_array(jsonb_build_object('invoiceId', v_o1, 'periodStart','2026-08-25','outstandingBefore',1500,'paidFromCredit',1500,'outstandingAfter',0))),
    jsonb_build_array(jsonb_build_object('invoice_id', v_o1, 'expected_paid_amount', 0)),
    2000, 100, 300, 2400));
  DROP TRIGGER zz_test_fail ON public.rooms;
  DROP FUNCTION public.zz_test_fail_room_update();
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = v_t; v_msg := 'invoices='||v_n;
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_o1; v_msg := v_msg||' older='||v_st;
  SELECT count(*) INTO v_n FROM payment_batches WHERE tenant_id = v_t; v_msg := v_msg||' batches='||v_n;
  SELECT count(*) INTO v_n FROM tenant_credits WHERE tenant_id = v_t; v_msg := v_msg||' credits='||v_n;
  SELECT count(*) INTO v_n FROM move_out_settlements WHERE tenant_id = v_t; v_msg := v_msg||' settlements='||v_n;
  SELECT count(*) INTO v_n FROM money_events WHERE tenant_id = v_t; v_msg := v_msg||' events='||v_n;
  SELECT status||'/'||(room_id = v_room) INTO v_st FROM tenants WHERE id = v_t; v_msg := v_msg||' tenant='||v_st;
  SELECT status INTO v_st FROM rooms WHERE id = v_room; v_msg := v_msg||' room='||v_st;
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:FORCED_TEST_FAILURE%' AND v_msg =
      'invoices=1 older=0.00/overdue batches=0 credits=0 settlements=0 events=0 tenant=active/true room=occupied'
    THEN 'PASS  F1 forced failure at last step left nothing written, room still occupied ('||v_msg||')'
    ELSE 'FAIL  F1 forced failure ('||v_r||' / '||v_msg||')' END;

  ---------------------------------------------------------------- S5 forfeiture without a reason is rejected (blank, spaces, tab/newline)
  -- Same F1 tenant (still active, untouched). deposit 3000, forfeit 500, advance 1000.
  -- owed 1500 + 2400 = 3900: advance 1000 + deposit 2500 -> but only 2500 available -> 400 still owed.
  FOREACH v_st IN ARRAY ARRAY['', '   ', E'\t\n'] LOOP
    v_p := pg_temp.payload(v_t, v_room, 'k-s5',
      pg_temp.plan(1000,1000,0, 3000,500,2500,0, 2400,2000,0,
        jsonb_build_array(jsonb_build_object('invoiceId', v_o1, 'periodStart','2026-08-25','outstandingBefore',1500,'paidFromCredit',1500,'outstandingAfter',0)),
        v_st),
      jsonb_build_array(jsonb_build_object('invoice_id', v_o1, 'expected_paid_amount', 0)),
      2000, 100, 300, 2000);
    v_r := pg_temp.try_settle(v_p);
    v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:FORFEIT_REASON_REQUIRED%'
      THEN 'PASS  S5 forfeiture with reason '||quote_literal(v_st)||' rejected' ELSE 'FAIL  S5 forfeiture reason '||quote_literal(v_st)||' ('||v_r||')' END;
  END LOOP;
  SELECT count(*) INTO v_n FROM tenant_credits WHERE tenant_id = v_t;
  v_out := v_out || E'\n' || CASE WHEN v_n = 0 THEN 'PASS  S5b nothing written by the rejected forfeitures' ELSE 'FAIL  S5b credits written='||v_n END;

  ---------------------------------------------------------------- S5c forfeiture WITH a reason (same tenant) is accepted and recorded
  v_p := pg_temp.payload(v_t, v_room, 'k-s5c',
    pg_temp.plan(1000,1000,0, 3000,500,2500,0, 2400,2000,0,
      jsonb_build_array(jsonb_build_object('invoiceId', v_o1, 'periodStart','2026-08-25','outstandingBefore',1500,'paidFromCredit',1500,'outstandingAfter',0)),
      'broken window'),
    jsonb_build_array(jsonb_build_object('invoice_id', v_o1, 'expected_paid_amount', 0)),
    2000, 100, 300, 2000);
  v_r := pg_temp.try_settle(v_p);
  SELECT string_agg(amount::numeric(12,2)||':'||reason, ',') INTO v_st FROM tenant_credits WHERE tenant_id = v_t AND kind = 'forfeited';
  SELECT total_amount::numeric(12,2)||'/'||status INTO v_msg FROM invoices WHERE tenant_id = v_t AND id <> v_o1;
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND v_st = '-500.00:broken window' AND v_msg = '400.00/pending'
    THEN 'PASS  S5c forfeiture with reason recorded (forfeited='||v_st||', final invoice still owes '||v_msg||')'
    ELSE 'FAIL  S5c ('||v_r||' forfeited='||COALESCE(v_st,'none')||' final='||COALESCE(v_msg,'none')||')' END;

  ---------------------------------------------------------------- S6 advance rent never becomes refund due
  -- advance 3000, deposit 2000, no older debt, final bill 1000 -> advance 1000 applied, 2000 absorbed; deposit 2000 refund due.
  INSERT INTO rooms(room_number, status) VALUES ('T-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id, status, security_deposit_amount, advance_rent_amount)
    VALUES ('Settle S6', '2026-01-01', v_room, 'active', 2000, 3000) RETURNING id INTO v_t;
  -- S6a a plan that pools leftover advance into the refund is rejected.
  v_r := pg_temp.try_settle(pg_temp.payload(v_t, v_room, 'k-s6a',
    pg_temp.plan(3000,1000,0, 2000,0,0,2000, 1000,1000,4000, '[]'::jsonb),
    '[]'::jsonb, 1000, 0, 0, 1000));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:PLAN_INVALID%'
    THEN 'PASS  S6a plan with leftover advance in refund due rejected ('||left(v_r, 70)||')' ELSE 'FAIL  S6a ('||v_r||')' END;
  v_r := pg_temp.try_settle(pg_temp.payload(v_t, v_room, 'k-s6a2',
    pg_temp.plan(3000,1000,2000, 2000,0,0,2000, 1000,1000,4000, '[]'::jsonb),
    '[]'::jsonb, 1000, 0, 0, 1000));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:PLAN_INVALID: refund due must equal%'
    THEN 'PASS  S6a2 refund due including absorbed advance rejected' ELSE 'FAIL  S6a2 ('||v_r||')' END;
  -- S6b the correct plan.
  v_r := pg_temp.try_settle(pg_temp.payload(v_t, v_room, 'k-s6',
    pg_temp.plan(3000,1000,2000, 2000,0,0,2000, 1000,1000,2000, '[]'::jsonb),
    '[]'::jsonb, 1000, 0, 0, 1000));
  SELECT deposit_held::numeric(12,2)||'/'||advance_held::numeric(12,2) INTO v_st FROM tenant_credit_balances WHERE tenant_id = v_t;
  SELECT refund_due::numeric(12,2)::text INTO v_msg FROM refund_due_vs_paid WHERE tenant_id = v_t;
  SELECT count(*) INTO v_n FROM tenant_credits WHERE tenant_id = v_t AND kind = 'forfeited' AND bucket = 'advance' AND amount = -2000 AND reason ~ '\S';
  SELECT count(*) INTO v_n2 FROM money_events WHERE tenant_id = v_t AND action = 'credit.absorb_advance';
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND v_st = '2000.00/0.00' AND v_msg = '2000.00' AND v_n = 1 AND v_n2 = 1
    THEN 'PASS  S6b advance never refund: balances deposit/advance='||v_st||', refund_due='||v_msg||' (deposit only), 2000 advance absorbed with reason + event'
    ELSE 'FAIL  S6b ('||v_r||' balances='||COALESCE(v_st,'null')||' refund='||COALESCE(v_msg,'null')||' absorbed_rows='||v_n||' events='||v_n2||')' END;

  ---------------------------------------------------------------- G1 guards: stale/missing debt, engine mismatch, room mismatch, verifying, held mismatch
  INSERT INTO rooms(room_number, status) VALUES ('T-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id, status, security_deposit_amount, advance_rent_amount)
    VALUES ('Settle G1', '2026-01-01', v_room, 'active', 3000, 0) RETURNING id INTO v_t;
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_t, v_room, '2026-08-25', '2026-09-05', '2026-08-25', '2026-09-24', 1500, 'overdue') RETURNING id INTO v_o1;
  -- debt left out of the plan, refund would have been 2000
  v_r := pg_temp.try_settle(pg_temp.payload(v_t, v_room, 'k-g1',
    pg_temp.plan(0,0,0, 3000,0,1000,2000, 1000,1000,2000, '[]'::jsonb), '[]'::jsonb, 1000, 0, 0, 1000));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:STALE_DEBTS%' THEN 'PASS  G1a open debt missing from plan rejected' ELSE 'FAIL  G1a ('||v_r||')' END;
  -- total_amount that disagrees with the engine
  v_r := pg_temp.try_settle(pg_temp.payload(v_t, v_room, 'k-g1b',
    pg_temp.plan(0,0,0, 3000,0,2500,500, 1000,1000,500,
      jsonb_build_array(jsonb_build_object('invoiceId', v_o1, 'periodStart','2026-08-25','outstandingBefore',1500,'paidFromCredit',1500,'outstandingAfter',0))),
    jsonb_build_array(jsonb_build_object('invoice_id', v_o1, 'expected_paid_amount', 0)), 1000, 0, 0, 1000, 999));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:ENGINE_MISMATCH%' THEN 'PASS  G1b invoice columns != engine rejected' ELSE 'FAIL  G1b ('||v_r||')' END;
  -- stale paid_amount
  v_r := pg_temp.try_settle(pg_temp.payload(v_t, v_room, 'k-g1c',
    pg_temp.plan(0,0,0, 3000,0,2500,500, 1000,1000,500,
      jsonb_build_array(jsonb_build_object('invoiceId', v_o1, 'periodStart','2026-08-25','outstandingBefore',1500,'paidFromCredit',1500,'outstandingAfter',0))),
    jsonb_build_array(jsonb_build_object('invoice_id', v_o1, 'expected_paid_amount', 200)), 1000, 0, 0, 1000));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:STALE_INVOICE%' THEN 'PASS  G1c stale paid_amount rejected' ELSE 'FAIL  G1c ('||v_r||')' END;
  -- wrong room
  v_r := pg_temp.try_settle(pg_temp.payload(v_t, gen_random_uuid(), 'k-g1d',
    pg_temp.plan(0,0,0, 3000,0,2500,500, 1000,1000,500, '[]'::jsonb), '[]'::jsonb, 1000, 0, 0, 1000));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:ROOM_MISMATCH%' THEN 'PASS  G1d wrong room rejected' ELSE 'FAIL  G1d ('||v_r||')' END;
  -- deposit held disagreeing with the tenant row
  v_r := pg_temp.try_settle(pg_temp.payload(v_t, v_room, 'k-g1e',
    pg_temp.plan(0,0,0, 9000,0,2500,6500, 1000,1000,6500,
      jsonb_build_array(jsonb_build_object('invoiceId', v_o1, 'periodStart','2026-08-25','outstandingBefore',1500,'paidFromCredit',1500,'outstandingAfter',0))),
    jsonb_build_array(jsonb_build_object('invoice_id', v_o1, 'expected_paid_amount', 0)), 1000, 0, 0, 1000));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:HELD_MISMATCH%' THEN 'PASS  G1e held deposit mismatch rejected' ELSE 'FAIL  G1e ('||v_r||')' END;
  -- a slip awaiting review blocks settlement
  UPDATE invoices SET status = 'verifying' WHERE id = v_o1;
  v_r := pg_temp.try_settle(pg_temp.payload(v_t, v_room, 'k-g1f',
    pg_temp.plan(0,0,0, 3000,0,2500,500, 1000,1000,500,
      jsonb_build_array(jsonb_build_object('invoiceId', v_o1, 'periodStart','2026-08-25','outstandingBefore',1500,'paidFromCredit',1500,'outstandingAfter',0))),
    jsonb_build_array(jsonb_build_object('invoice_id', v_o1, 'expected_paid_amount', 0)), 1000, 0, 0, 1000));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:VERIFYING_INVOICE%' THEN 'PASS  G1f verifying invoice blocks settlement' ELSE 'FAIL  G1f ('||v_r||')' END;
  SELECT count(*) INTO v_n FROM tenant_credits WHERE tenant_id = v_t;
  SELECT (room_id = v_room)::text INTO v_st FROM tenants WHERE id = v_t;
  v_out := v_out || E'\n' || CASE WHEN v_n = 0 AND v_st = 'true' THEN 'PASS  G1g rejected calls left no credits and the tenant in the room' ELSE 'FAIL  G1g credits='||v_n END;

  RAISE EXCEPTION 'RESULT:%', v_out;
END $t$;
