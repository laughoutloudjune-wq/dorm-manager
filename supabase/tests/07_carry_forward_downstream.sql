-- Rollback-wrapped tests for carry-forward status propagation (finding 178) and the
-- settlement own-outstanding rule (finding 177).
-- Run ONLY on the dummy project dorm-test (rghxelkifdrpvabyxopb). Never on production.
-- Nothing persists: the block ends with RAISE EXCEPTION 'RESULT: ...'.
--
-- Covers: record_payment_batch / void_payment_batch re-deriving DOWNSTREAM carry-forward targets
-- (two-invoice and three-invoice chains, longer-chain recursion), atomic rollback when a downstream
-- step fails, targets that must not change (verifying with a slip, cancelled, draft), legacy-shaped
-- rows, and final_settle_move_out using max(0, total - carry - paid).

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

-- pay p_amount onto one invoice; status in the payload comes from the SAME SQL rule the function enforces
CREATE OR REPLACE FUNCTION pg_temp.pay(p_tenant uuid, p_inv uuid, p_amount numeric, p_key text)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE r public.invoices%ROWTYPE; v_new numeric; v_status public.invoice_status; v_id uuid := gen_random_uuid(); v_res jsonb;
BEGIN
  SELECT * INTO r FROM public.invoices WHERE id = p_inv;
  v_new := r.paid_amount + p_amount;
  v_status := public.money_derive_invoice_status_cf(p_inv, r.total_amount, v_new, r.due_date,
                (now() AT TIME ZONE 'Asia/Bangkok')::date, jsonb_build_object(p_inv::text, v_new));
  v_res := public.record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', v_id, 'tenant_id', p_tenant, 'trigger_invoice_id', p_inv, 'amount_received', p_amount,
              'amount_allocated', p_amount, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key',p_key,'created_by','tester'),
    'invoices', jsonb_build_array(jsonb_build_object('id', p_inv, 'expected_paid_amount', r.paid_amount,
              'expected_history_length', jsonb_array_length(r.payment_history), 'paid_amount', v_new, 'status', v_status)),
    'allocations', jsonb_build_array(jsonb_build_object('invoice_id', p_inv, 'amount', p_amount, 'source','cash'))));
  RETURN v_res || jsonb_build_object('batch_id', v_id);
END $f$;

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
      'additional_fees_breakdown', jsonb_build_array(jsonb_build_object('item_type','prorate_rent','label','prorate','amount',fees)),
      'notes', 'test'),
    'charges', jsonb_build_object('rent', 0, 'water', 0, 'electricity', 0, 'commonFee', 0, 'nativeLateFee', 0,
      'lateFeeItems', 0, 'fees', fees, 'carryForward', 0, 'discount', discount))
$f$;

DO $t$
DECLARE
  v_out text := '';
  v_room uuid; v_ta uuid; v_tb uuid;
  v_due date := current_date + 30;
  v_apr uuid; v_may uuid; v_res jsonb; v_b_apr uuid; v_st text; v_n int; v_n2 int; v_msg text;
  v_a uuid; v_b uuid; v_c uuid; v_ba uuid;
  v_s uuid; v_x uuid; v_sv uuid; v_sc uuid; v_sd uuid; v_tv uuid; v_tc uuid; v_td uuid; v_sl uuid; v_l uuid;
  v_rc uuid; v_tcn uuid; v_o uuid; v_r text; v_p jsonb;
BEGIN
  INSERT INTO rooms(room_number) VALUES ('T-'||gen_random_uuid()) RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id) VALUES ('Chain A', current_date, v_room) RETURNING id INTO v_ta;
  INSERT INTO tenants(full_name, move_in_date, room_id, status) VALUES ('Chain B', current_date, v_room, 'inactive') RETURNING id INTO v_tb;

  ---------------------------------------------------------------- K1 pay a source -> its target is settled in the same call
  v_apr := pg_temp.ni(v_ta, v_room, 1400, 0, 0, 'pending', v_due);
  v_may := pg_temp.ni(v_ta, v_room, 7594, 1400, 0, 'pending', v_due);
  INSERT INTO invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_apr, v_may, 1400);
  v_res := pg_temp.pay(v_ta, v_may, 6194, 'k1a');
  v_out := v_out || E'\n' || CASE WHEN pg_temp.st(v_may) = '6194.00/partial' THEN 'PASS  K1a May own share paid while April is open stays partial ('||pg_temp.st(v_may)||')'
                                  ELSE 'FAIL  K1a '||pg_temp.st(v_may) END;
  UPDATE invoices SET locked_late_fee_amount = NULL WHERE id = v_may;
  v_res := pg_temp.pay(v_ta, v_apr, 1400, 'k1b');
  v_b_apr := (v_res->>'batch_id')::uuid;
  SELECT count(*) INTO v_n FROM money_events WHERE invoice_id = v_may AND action = 'invoice.status_rederive' AND payment_batch_id = v_b_apr;
  v_out := v_out || E'\n' || CASE WHEN pg_temp.st(v_may) = '6194.00/paid' AND pg_temp.st(v_apr) = '1400.00/paid'
      AND (v_res->'downstream_updated') @> to_jsonb(v_may::text) AND v_n = 1
    THEN 'PASS  K1b paying April settles May in the same transaction (May '||pg_temp.st(v_may)||', event rows='||v_n||', paid_amount untouched)'
    ELSE 'FAIL  K1b May='||pg_temp.st(v_may)||' April='||pg_temp.st(v_apr)||' downstream='||(v_res->>'downstream_updated')||' events='||v_n END;

  ---------------------------------------------------------------- K2 void that payment -> May reopens, frozen fee cleared
  UPDATE invoices SET locked_late_fee_amount = 75 WHERE id = v_may;
  v_res := void_payment_batch(v_b_apr, 'wrong slip', 'tester');
  SELECT count(*) INTO v_n FROM money_events WHERE invoice_id = v_may AND action = 'invoice.status_rederive' AND payment_batch_id = v_b_apr;
  SELECT COALESCE(locked_late_fee_amount::text,'NULL') INTO v_msg FROM invoices WHERE id = v_may;
  v_out := v_out || E'\n' || CASE WHEN pg_temp.st(v_may) = '6194.00/partial' AND pg_temp.st(v_apr) = '0.00/pending'
      AND (v_res->'downstream_updated') @> to_jsonb(v_may::text) AND v_n = 2 AND v_msg = 'NULL'
    THEN 'PASS  K2 voiding April reopens May to partial, clears its frozen fee, paid_amount unchanged ('||pg_temp.st(v_may)||')'
    ELSE 'FAIL  K2 May='||pg_temp.st(v_may)||' April='||pg_temp.st(v_apr)||' events='||v_n||' lock='||v_msg END;

  ---------------------------------------------------------------- K3 three-invoice chain A -> B -> C, both directions
  v_a := pg_temp.ni(v_ta, v_room, 1000, 0, 0, 'pending', v_due);
  v_b := pg_temp.ni(v_ta, v_room, 2500, 1000, 0, 'pending', v_due);
  v_c := pg_temp.ni(v_ta, v_room, 6000, 2500, 0, 'pending', v_due);
  INSERT INTO invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_a, v_b, 1000), (v_b, v_c, 2500);
  PERFORM pg_temp.pay(v_ta, v_c, 3500, 'k3c');
  PERFORM pg_temp.pay(v_ta, v_b, 1500, 'k3b');
  v_msg := 'before A: B='||pg_temp.st(v_b)||' C='||pg_temp.st(v_c);
  v_res := pg_temp.pay(v_ta, v_a, 1000, 'k3a');
  v_ba := (v_res->>'batch_id')::uuid;
  v_out := v_out || E'\n' || CASE WHEN v_msg = 'before A: B=1500.00/partial C=3500.00/partial'
      AND pg_temp.st(v_a) = '1000.00/paid' AND pg_temp.st(v_b) = '1500.00/paid' AND pg_temp.st(v_c) = '3500.00/paid'
      AND (v_res->'downstream_updated') @> to_jsonb(v_b::text) AND (v_res->'downstream_updated') @> to_jsonb(v_c::text)
    THEN 'PASS  K3a paying A settles B and (recursively) C ('||v_msg||' -> A='||pg_temp.st(v_a)||' B='||pg_temp.st(v_b)||' C='||pg_temp.st(v_c)||')'
    ELSE 'FAIL  K3a '||v_msg||' -> A='||pg_temp.st(v_a)||' B='||pg_temp.st(v_b)||' C='||pg_temp.st(v_c)||' ds='||(v_res->>'downstream_updated') END;
  v_res := void_payment_batch(v_ba, 'A receipt wrong', 'tester');
  v_out := v_out || E'\n' || CASE WHEN pg_temp.st(v_a) = '0.00/pending' AND pg_temp.st(v_b) = '1500.00/partial' AND pg_temp.st(v_c) = '3500.00/partial'
      AND (v_res->'downstream_updated') @> to_jsonb(v_b::text) AND (v_res->'downstream_updated') @> to_jsonb(v_c::text)
    THEN 'PASS  K3b voiding A reopens B and C ('||pg_temp.st(v_b)||', '||pg_temp.st(v_c)||')'
    ELSE 'FAIL  K3b A='||pg_temp.st(v_a)||' B='||pg_temp.st(v_b)||' C='||pg_temp.st(v_c) END;

  ---------------------------------------------------------------- K4 atomicity: a failing downstream step rolls the whole call back
  v_s := pg_temp.ni(v_ta, v_room, 500, 0, 0, 'pending', v_due);
  v_x := pg_temp.ni(v_tb, v_room, 900, 500, 300, 'partial', v_due);   -- target owned by ANOTHER tenant
  INSERT INTO invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_s, v_x, 500);
  BEGIN
    PERFORM pg_temp.pay(v_ta, v_s, 500, 'k4');
    v_out := v_out || E'\n' || 'FAIL  K4 payment accepted although a downstream target belongs to another tenant';
  EXCEPTION WHEN OTHERS THEN
    SELECT count(*) INTO v_n FROM payment_batches WHERE trigger_invoice_id = v_s;
    SELECT count(*) INTO v_msg FROM money_events WHERE invoice_id IN (v_s, v_x);
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'CROSS_TENANT_CARRY%' AND v_n = 0 AND pg_temp.st(v_s) = '0.00/pending'
        AND pg_temp.st(v_x) = '300.00/partial' AND v_msg = '0'
      THEN 'PASS  K4 record rolled back completely: no batch, no money, no events, target untouched ('||left(SQLERRM,40)||'...)'
      ELSE 'FAIL  K4 '||SQLERRM||' batches='||v_n||' S='||pg_temp.st(v_s)||' X='||pg_temp.st(v_x)||' events='||v_msg END;
  END;
  -- void side: pay first while the link does not exist, then add the bad link, then void
  v_s := pg_temp.ni(v_ta, v_room, 500, 0, 0, 'pending', v_due);
  v_x := pg_temp.ni(v_tb, v_room, 900, 500, 300, 'partial', v_due);
  v_res := pg_temp.pay(v_ta, v_s, 500, 'k4v');
  INSERT INTO invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_s, v_x, 500);
  BEGIN
    PERFORM void_payment_batch((v_res->>'batch_id')::uuid, 'test', 'tester');
    v_out := v_out || E'\n' || 'FAIL  K4v void accepted although a downstream target belongs to another tenant';
  EXCEPTION WHEN OTHERS THEN
    SELECT count(*) INTO v_n FROM payment_batches WHERE id = (v_res->>'batch_id')::uuid AND voided_at IS NULL;
    SELECT count(*) INTO v_msg FROM invoice_payment_allocations WHERE payment_batch_id = (v_res->>'batch_id')::uuid;
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'CROSS_TENANT_CARRY%' AND v_n = 1 AND v_msg = '1' AND pg_temp.st(v_s) = '500.00/paid'
      THEN 'PASS  K4v void rolled back completely: batch not voided, no reversal rows, invoice still paid'
      ELSE 'FAIL  K4v '||SQLERRM||' unvoided='||v_n||' allocs='||v_msg||' S='||pg_temp.st(v_s) END;
  END;

  ---------------------------------------------------------------- K5 targets that must not be touched
  v_sv := pg_temp.ni(v_ta, v_room, 500, 0, 0, 'pending', v_due);
  v_sc := pg_temp.ni(v_ta, v_room, 500, 0, 0, 'pending', v_due);
  v_sd := pg_temp.ni(v_ta, v_room, 500, 0, 0, 'pending', v_due);
  v_tv := pg_temp.ni(v_ta, v_room, 900, 500, 400, 'verifying', v_due);
  UPDATE invoices SET slip_url = 'https://example.test/slip.png' WHERE id = v_tv;
  v_tc := pg_temp.ni(v_ta, v_room, 900, 500, 400, 'cancelled', v_due);
  v_td := pg_temp.ni(v_ta, v_room, 900, 500, 400, 'draft', v_due);
  INSERT INTO invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_sv, v_tv, 500), (v_sc, v_tc, 500), (v_sd, v_td, 500);
  PERFORM pg_temp.pay(v_ta, v_sv, 500, 'k5v');
  PERFORM pg_temp.pay(v_ta, v_sc, 500, 'k5c');
  PERFORM pg_temp.pay(v_ta, v_sd, 500, 'k5d');
  v_out := v_out || E'\n' || CASE WHEN pg_temp.st(v_tv) = '400.00/verifying' AND pg_temp.st(v_tc) = '400.00/cancelled' AND pg_temp.st(v_td) = '400.00/draft'
    THEN 'PASS  K5 target awaiting slip review stays verifying; cancelled and draft targets untouched'
    ELSE 'FAIL  K5 verifying='||pg_temp.st(v_tv)||' cancelled='||pg_temp.st(v_tc)||' draft='||pg_temp.st(v_td) END;

  ---------------------------------------------------------------- K6 legacy-shaped target (paid_amount already includes the carried part)
  v_sl := pg_temp.ni(v_ta, v_room, 1446, 0, 0, 'pending', v_due);
  v_l := pg_temp.ni(v_ta, v_room, 6244, 1446, 6000, 'partial', v_due);   -- room 114/1 shape: 244 still owed
  INSERT INTO invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_sl, v_l, 1446);
  v_res := pg_temp.pay(v_ta, v_sl, 1446, 'k6');
  v_out := v_out || E'\n' || CASE WHEN pg_temp.st(v_l) = '6000.00/partial' AND NOT ((v_res->'downstream_updated') @> to_jsonb(v_l::text))
    THEN 'PASS  K6 legacy-inflated target keeps owing its 244: not flipped to paid by the carried-in credit ('||pg_temp.st(v_l)||')'
    ELSE 'FAIL  K6 '||pg_temp.st(v_l)||' ds='||(v_res->>'downstream_updated') END;

  ---------------------------------------------------------------- K7 idempotent replay does not run the downstream step again
  SELECT count(*) INTO v_n2 FROM money_events WHERE action = 'invoice.status_rederive' AND payment_batch_id = v_ba;
  v_res := pg_temp.pay(v_ta, v_a, 1000, 'k3a');   -- same key as K3a
  SELECT count(*) INTO v_n FROM money_events WHERE action = 'invoice.status_rederive' AND payment_batch_id = v_ba;
  v_out := v_out || E'
' || CASE WHEN (v_res->>'replayed') = 'true' AND v_n = v_n2 AND v_n2 = 4
    THEN 'PASS  K7 replay returns the original and writes no further status_rederive events (still '||v_n||': 2 from the payment, 2 from its void)'
    ELSE 'FAIL  K7 replayed='||(v_res->>'replayed')||' events before='||v_n2||' after='||v_n END;

  ---------------------------------------------------------------- K8 legacy-shaped MIDDLE invoice must not look settled
  -- A (1,446, unpaid) -> M (total 6,244, carry 1,446, paid 6,000: still owes 244) -> C (total 9,000, carry 6,244, own paid 2,756)
  v_a := pg_temp.ni(v_ta, v_room, 1446, 0, 0, 'pending', v_due);
  v_b := pg_temp.ni(v_ta, v_room, 6244, 1446, 6000, 'partial', v_due);
  v_c := pg_temp.ni(v_ta, v_room, 9000, 6244, 2756, 'partial', v_due);
  INSERT INTO invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_a, v_b, 1446), (v_b, v_c, 6244);
  v_res := pg_temp.pay(v_ta, v_a, 1446, 'k8');
  v_out := v_out || E'
' || CASE WHEN pg_temp.st(v_a) = '1446.00/paid' AND pg_temp.st(v_b) = '6000.00/partial' AND pg_temp.st(v_c) = '2756.00/partial'
      AND public.money_carried_in_settled(v_c) = 0 AND public.money_carried_in_settled(v_b) = 1446
      AND NOT ((v_res->'downstream_updated') @> to_jsonb(v_b::text)) AND NOT ((v_res->'downstream_updated') @> to_jsonb(v_c::text))
    THEN 'PASS  K8 legacy middle invoice (6,244 / 1,446 / 6,000) still owes 244 and does not make the later invoice look settled (A paid; M '||pg_temp.st(v_b)||'; C '||pg_temp.st(v_c)||'; carried-in for C = 0)'
    ELSE 'FAIL  K8 A='||pg_temp.st(v_a)||' M='||pg_temp.st(v_b)||' C='||pg_temp.st(v_c)||' cin(C)='||public.money_carried_in_settled(v_c)||' cin(M)='||public.money_carried_in_settled(v_b)||' ds='||(v_res->>'downstream_updated') END;

  ---------------------------------------------------------------- G2 settlement: own outstanding = max(0, total - carry - paid)
  INSERT INTO rooms(room_number, status) VALUES ('T-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_rc;
  INSERT INTO tenants(full_name, move_in_date, room_id, status, security_deposit_amount, advance_rent_amount)
    VALUES ('Settle G2a', '2026-01-01', v_rc, 'active', 3000, 0) RETURNING id INTO v_tcn;
  v_o := pg_temp.ni(v_tcn, v_rc, 7594, 1400, 6194, 'partial', '2026-09-05');
  v_r := pg_temp.try_settle(pg_temp.payload(v_tcn, v_rc, 'k-g2a',
           pg_temp.plan(0,0,0, 3000,0,1000,2000, 1000,1000,2000, '[]'::jsonb), '[]'::jsonb, 1000, 1000));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' THEN 'PASS  G2a 7,594 total / 1,400 carried / 6,194 own paid owes nothing: settlement needs no debt line for it'
    ELSE 'FAIL  G2a '||v_r END;

  INSERT INTO rooms(room_number, status) VALUES ('T-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_rc;
  INSERT INTO tenants(full_name, move_in_date, room_id, status, security_deposit_amount, advance_rent_amount)
    VALUES ('Settle G2b', '2026-01-01', v_rc, 'active', 3000, 0) RETURNING id INTO v_tcn;
  v_o := pg_temp.ni(v_tcn, v_rc, 6244, 1446, 6000, 'partial', '2026-09-05');
  v_r := pg_temp.try_settle(pg_temp.payload(v_tcn, v_rc, 'k-g2b',
           pg_temp.plan(0,0,0, 3000,0,1000,2000, 1000,1000,2000, '[]'::jsonb), '[]'::jsonb, 1000, 1000));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:STALE_DEBTS%' THEN 'PASS  G2b legacy-shaped 6,244 / 1,446 / 6,000 still owes 244: a plan that leaves it out is rejected'
    ELSE 'FAIL  G2b '||v_r END;
  v_r := pg_temp.try_settle(pg_temp.payload(v_tcn, v_rc, 'k-g2c',
           pg_temp.plan(0,0,0, 3000,0,1244,1756, 1000,1000,1756,
             jsonb_build_array(jsonb_build_object('invoiceId', v_o, 'periodStart','2026-08-25','outstandingBefore',244,'paidFromCredit',244,'outstandingAfter',0))),
           jsonb_build_array(jsonb_build_object('invoice_id', v_o, 'expected_paid_amount', 6000)), 1000, 1000));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND pg_temp.st(v_o) = '6244.00/paid'
    THEN 'PASS  G2c the 244 is paid from credit and the legacy invoice settles ('||pg_temp.st(v_o)||')'
    ELSE 'FAIL  G2c '||v_r||' invoice='||pg_temp.st(v_o) END;

  RAISE EXCEPTION 'RESULT:%', v_out;
END
$t$;
