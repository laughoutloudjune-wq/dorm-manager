-- Rollback-wrapped tests: refund payouts and move-out settlement correction (item 5).
-- Run ONLY on the dummy project dorm-test (rghxelkifdrpvabyxopb). Never on production.
-- Nothing persists: the block ends with RAISE EXCEPTION 'RESULT: ...'.
--
-- R1-R9   record_refund_payout / void_refund_payout
-- S1-S8   void_move_out_settlement

CREATE OR REPLACE FUNCTION pg_temp.ni(p_tenant uuid, p_room uuid, p_total numeric, p_carry numeric, p_paid numeric,
                                      p_status text, p_due date)
RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO public.invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, carry_forward_amount,
                              paid_amount, status)
  VALUES (p_tenant, p_room, current_date, p_due, current_date, current_date, p_total, p_carry, p_paid, p_status::public.invoice_status)
  RETURNING id
$f$;

CREATE OR REPLACE FUNCTION pg_temp.st(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT paid_amount::numeric(12,2) || '/' || status FROM public.invoices WHERE id = p_id
$f$;

CREATE OR REPLACE FUNCTION pg_temp.try(p_fn text, p jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  EXECUTE format('SELECT public.%I($1)', p_fn) INTO v USING p;
  RETURN 'OK:' || v::text;
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

-- A settled tenant: deposit 3,000; older invoice A (1,000) and the 1,000 final bill paid from credit; refund due 1,000.
-- With p_chain, A also carries into B (2,500 total, own share 1,500 paid) so settling A settles B.
CREATE OR REPLACE FUNCTION pg_temp.mk_settled(p_key text, p_chain boolean DEFAULT false, p_tenant_date date DEFAULT '2026-09-30',
                                              p_req_date date DEFAULT '2026-09-30', p_forfeit boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_room uuid; v_t uuid; v_a uuid; v_b uuid; v_r text; v_res jsonb;
BEGIN
  INSERT INTO public.rooms(room_number, status) VALUES ('T-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_room;
  INSERT INTO public.tenants(full_name, move_in_date, move_out_date, room_id, status, security_deposit_amount, advance_rent_amount, forfeit_security_deposit)
    VALUES ('Corr ' || p_key, '2026-01-01', p_tenant_date, v_room, 'active', 3000, 0, p_forfeit) RETURNING id INTO v_t;
  INSERT INTO public.room_tenant_logs(room_id, tenant_id, tenant_name, move_in_date) VALUES (v_room, v_t, 'Corr', '2026-01-01');
  INSERT INTO public.move_out_requests(tenant_id, requested_move_out_date, status) VALUES (v_t, p_req_date, 'approved');
  v_a := pg_temp.ni(v_t, v_room, 1000, 0, 0, 'overdue', '2026-09-05');
  IF p_chain THEN
    v_b := pg_temp.ni(v_t, v_room, 2500, 1000, 1500, 'partial', '2026-09-05');
    INSERT INTO public.invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_a, v_b, 1000);
  END IF;
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload(v_t, v_room, p_key,
           pg_temp.plan(0,0,0, 3000,0,2000,1000, 1000,1000,1000,
             jsonb_build_array(jsonb_build_object('invoiceId', v_a, 'periodStart','2026-08-25','outstandingBefore',1000,'paidFromCredit',1000,'outstandingAfter',0))),
           jsonb_build_array(jsonb_build_object('invoice_id', v_a, 'expected_paid_amount', 0)), 1000, 1000));
  IF v_r NOT LIKE 'OK:%' THEN RAISE EXCEPTION 'mk_settled setup failed: %', v_r; END IF;
  v_res := substr(v_r, 4)::jsonb;
  RETURN jsonb_build_object('tenant', v_t, 'room', v_room, 'a', v_a, 'b', v_b,
                            'final', v_res->>'final_invoice_id', 'settlement', v_res->>'settlement_id');
END $f$;

CREATE OR REPLACE FUNCTION pg_temp.rfp(p_tenant uuid, p_key text, p_amount numeric, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.try('record_refund_payout', jsonb_build_object('tenant_id', p_tenant, 'idempotency_key', p_key, 'amount', p_amount,
     'paid_at', now()::text, 'method', 'bank transfer', 'recipient', 'Tenant Name', 'reference', 'TRX-1', 'actor', 'tester') || p_extra)
$f$;

CREATE OR REPLACE FUNCTION pg_temp.due(p_tenant uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT refund_due::numeric(12,2) || '/' || refund_paid::numeric(12,2) || '/' || refund_outstanding::numeric(12,2)
  FROM public.refund_due_vs_paid WHERE tenant_id = p_tenant
$f$;

DO $t$
DECLARE
  v_out text := '';
  m jsonb; v_t uuid; v_room uuid; v_a uuid; v_b uuid; v_final uuid; v_set uuid;
  v_r text; v_n int; v_msg text; v_pid uuid; v_cnt_before text; v_cnt_after text;
BEGIN
  ---------------------------------------------------------------- R1 record a refund payout against refund due
  m := pg_temp.mk_settled('corr1'); v_t := (m->>'tenant')::uuid;
  v_r := pg_temp.rfp(v_t, 'p1', 600);
  IF v_r LIKE 'OK:%' THEN v_pid := (substr(v_r, 4)::jsonb->>'payout_id')::uuid; END IF;
  SELECT count(*) INTO v_n FROM money_events WHERE tenant_id = v_t AND action = 'refund.payout';
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND pg_temp.due(v_t) = '1000.00/600.00/400.00' AND v_n = 1
    THEN 'PASS  R1 refund payout of 600 recorded against refund due 1,000 (due/paid/outstanding '||pg_temp.due(v_t)||'), audit event written'
    ELSE 'FAIL  R1 '||left(v_r,150)||' '||COALESCE(pg_temp.due(v_t),'null') END;

  ---------------------------------------------------------------- R2 / R3 idempotency
  v_r := pg_temp.rfp(v_t, 'p1', 600);
  SELECT count(*) INTO v_n FROM refund_payouts WHERE tenant_id = v_t;
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND (substr(v_r,4)::jsonb->>'replayed') = 'true' AND v_n = 1
    THEN 'PASS  R2 retry with the same key replays the original payout (1 row)' ELSE 'FAIL  R2 '||left(v_r,120)||' rows='||v_n END;
  v_r := pg_temp.rfp(v_t, 'p1', 700);
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:IDEMPOTENCY_CONFLICT%' THEN 'PASS  R3 same key with a different amount is rejected (IDEMPOTENCY_CONFLICT)'
    ELSE 'FAIL  R3 '||left(v_r,120) END;

  ---------------------------------------------------------------- R4 cannot pay out more than is still due
  v_r := pg_temp.rfp(v_t, 'p2', 500);
  SELECT count(*) INTO v_n FROM refund_payouts WHERE tenant_id = v_t;
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:REFUND_EXCEEDS_DUE%' AND v_n = 1 AND pg_temp.due(v_t) = '1000.00/600.00/400.00'
    THEN 'PASS  R4 payout above the outstanding 400 is rejected and nothing is written' ELSE 'FAIL  R4 '||left(v_r,120)||' rows='||v_n END;

  ---------------------------------------------------------------- R5 required details and valid values
  v_msg := '';
  IF pg_temp.rfp(v_t, 'p3a', 10, '{"recipient":"  "}') NOT LIKE 'ERR:INVALID_PAYLOAD%' THEN v_msg := v_msg || ' recipient'; END IF;
  IF pg_temp.rfp(v_t, 'p3b', 10, '{"method":""}') NOT LIKE 'ERR:INVALID_PAYLOAD%' THEN v_msg := v_msg || ' method'; END IF;
  IF pg_temp.rfp(v_t, 'p3c', 10, '{"reference":"","evidence_url":null}') NOT LIKE 'ERR:INVALID_PAYLOAD%' THEN v_msg := v_msg || ' reference/evidence'; END IF;
  IF pg_temp.rfp(v_t, 'p3d', 0) NOT LIKE 'ERR:INVALID_PAYLOAD%' THEN v_msg := v_msg || ' amount0'; END IF;
  IF pg_temp.rfp(v_t, 'p3e', 10.005) NOT LIKE 'ERR:INVALID_PAYLOAD%' THEN v_msg := v_msg || ' 3dec'; END IF;
  IF pg_temp.rfp(v_t, 'p3f', 10, jsonb_build_object('paid_at', (now() + interval '3 days')::text)) NOT LIKE 'ERR:PAID_AT_IN_FUTURE%' THEN v_msg := v_msg || ' future'; END IF;
  IF pg_temp.rfp(v_t, 'p3h', 10, jsonb_build_object('paid_at', (now() + interval '1 minute')::text)) NOT LIKE 'ERR:PAID_AT_IN_FUTURE%' THEN v_msg := v_msg || ' future-1min-no-tolerance'; END IF;
  IF pg_temp.rfp(v_t, 'p3g', 10, '{"reference":"","evidence_url":"https://example.test/slip.png"}') NOT LIKE 'OK:%' THEN v_msg := v_msg || ' evidence-only-should-be-ok'; END IF;
  v_out := v_out || E'\n' || CASE WHEN v_msg = '' THEN 'PASS  R5 blank recipient / method / no reference-or-evidence / zero or 3-decimal amount / future date all rejected; evidence link alone is enough'
    ELSE 'FAIL  R5 problems:'||v_msg END;

  ---------------------------------------------------------------- R6 not settled -> no refund
  INSERT INTO rooms(room_number, status) VALUES ('T-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id, status, security_deposit_amount) VALUES ('Not settled', '2026-01-01', v_room, 'active', 3000) RETURNING id INTO v_a;
  INSERT INTO tenant_credits(tenant_id, kind, bucket, amount) VALUES (v_a, 'deposit_received', 'deposit', 3000);
  v_r := pg_temp.rfp(v_a, 'p4', 100);
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:NOT_SETTLED%' THEN 'PASS  R6 a held deposit before settlement is not refund due: payout rejected (NOT_SETTLED)'
    ELSE 'FAIL  R6 '||left(v_r,120) END;

  ---------------------------------------------------------------- R7 advance rent is never refundable
  INSERT INTO rooms(room_number, status) VALUES ('T-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id, status, security_deposit_amount, advance_rent_amount)
    VALUES ('Advance only', '2026-01-01', v_room, 'active', 0, 3000) RETURNING id INTO v_a;
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload(v_a, v_room, 'corr-adv',
           pg_temp.plan(3000,1000,2000, 0,0,0,0, 1000,1000,0, '[]'::jsonb), '[]'::jsonb, 1000, 1000));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND pg_temp.rfp(v_a, 'p5', 1) LIKE 'ERR:REFUND_EXCEEDS_DUE%'
    THEN 'PASS  R7 advance rent (3,000: 1,000 used, 2,000 absorbed) leaves no refund due: even a payout of 1 is rejected'
    ELSE 'FAIL  R7 settle='||left(v_r,100)||' payout='||left(pg_temp.rfp(v_a,'p5b',1),100) END;

  ---------------------------------------------------------------- R8 void a payout
  v_r := pg_temp.try('void_refund_payout', jsonb_build_object('payout_id', v_pid, 'reason', E'\t\n', 'actor', 'tester'));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:REASON_REQUIRED%' THEN 'PASS  R8a void with a tab/newline-only reason is rejected' ELSE 'FAIL  R8a '||left(v_r,100) END;
  v_r := pg_temp.try('void_refund_payout', jsonb_build_object('payout_id', v_pid, 'reason', 'sent to the wrong account', 'actor', 'tester'));
  SELECT count(*) INTO v_n FROM money_events WHERE tenant_id = v_t AND action = 'refund.void';
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND pg_temp.due(v_t) = '1000.00/10.00/990.00' AND v_n = 1
    THEN 'PASS  R8b void restores the refund outstanding (only the 10 evidence-only payout from R5 remains: '||pg_temp.due(v_t)||'), audit event written'
    ELSE 'FAIL  R8b '||left(v_r,100)||' '||COALESCE(pg_temp.due(v_t),'null')||' events='||v_n END;
  v_r := pg_temp.try('void_refund_payout', jsonb_build_object('payout_id', v_pid, 'reason', 'again', 'actor', 'tester'));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:ALREADY_VOIDED%' THEN 'PASS  R9 second void of the same payout is rejected' ELSE 'FAIL  R9 '||left(v_r,100) END;

  ---------------------------------------------------------------- S: void a settlement
  -- void the small R5 payout first so the settlement can be reversed
  UPDATE refund_payouts SET voided_at = now(), voided_by = 'tester', void_reason = 'cleanup' WHERE tenant_id = v_t AND voided_at IS NULL;
  v_a := (m->>'a')::uuid; v_final := (m->>'final')::uuid; v_set := (m->>'settlement')::uuid; v_room := (m->>'room')::uuid;
  v_msg := pg_temp.st(v_a) || ' final=' || pg_temp.st(v_final);
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', E' \t', 'actor', 'tester'));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:REASON_REQUIRED%' THEN 'PASS  S8 settlement void without a real reason is rejected' ELSE 'FAIL  S8 '||left(v_r,100) END;
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'wrong readings entered', 'actor', 'tester'));
  SELECT string_agg(deposit_held::numeric(12,2) || '/' || advance_held::numeric(12,2), '') INTO v_msg FROM tenant_credit_balances WHERE tenant_id = v_t;
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%'
      AND pg_temp.st(v_a) = '0.00/overdue' AND (SELECT status FROM invoices WHERE id = v_final) = 'cancelled'
      AND (SELECT status||'/'||(room_id = v_room) FROM tenants WHERE id = v_t) = 'active/true'
      AND (SELECT status FROM rooms WHERE id = v_room) = 'occupied'
      AND v_msg = '3000.00/0.00' AND pg_temp.due(v_t) IS NULL
      AND (SELECT voided_at IS NOT NULL FROM move_out_settlements WHERE id = v_set)
      AND (SELECT count(*) FROM invoice_payment_allocations WHERE invoice_id = v_a) = 2
      AND (SELECT COALESCE(sum(amount),0) FROM invoice_payment_allocations WHERE invoice_id = v_a) = 0
      AND (SELECT status FROM move_out_requests WHERE tenant_id = v_t) = 'approved'
      AND (SELECT move_out_date IS NULL FROM room_tenant_logs WHERE tenant_id = v_t)
    THEN 'PASS  S1 settlement void restores everything: older invoice reopened (0/overdue), final invoice cancelled, tenant active in the room, room occupied, held deposit back to 3,000, allocations net to 0, request approved again, log reopened'
    ELSE 'FAIL  S1 '||left(v_r,200)||' A='||pg_temp.st(v_a)||' credits='||COALESCE(v_msg,'null') END;
  SELECT count(*) INTO v_n FROM money_events WHERE tenant_id = v_t AND action IN ('settlement.void','settlement.void_allocation','settlement.void_final_invoice');
  v_out := v_out || E'\n' || CASE WHEN v_n = 3 THEN 'PASS  S1b three audit events written (void, allocation, final invoice)' ELSE 'FAIL  S1b events='||v_n END;
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'again', 'actor', 'tester'));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:ALREADY_VOIDED%' THEN 'PASS  S1c second void of the same settlement is rejected' ELSE 'FAIL  S1c '||left(v_r,100) END;
  v_out := v_out || E'\n' || CASE WHEN pg_temp.rfp(v_t, 'p6', 10) LIKE 'ERR:NOT_SETTLED%' THEN 'PASS  S1d no refund can be paid while the settlement is voided'
    ELSE 'FAIL  S1d' END;

  -- S5 the tenant can be settled again after the void (new key)
  v_r := pg_temp.try('final_settle_move_out', pg_temp.payload(v_t, v_room, 'corr1-again',
           pg_temp.plan(0,0,0, 3000,0,2000,1000, 1000,1000,1000,
             jsonb_build_array(jsonb_build_object('invoiceId', v_a, 'periodStart','2026-08-25','outstandingBefore',1000,'paidFromCredit',1000,'outstandingAfter',0))),
           jsonb_build_array(jsonb_build_object('invoice_id', v_a, 'expected_paid_amount', 0)), 1000, 1000));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND pg_temp.st(v_a) = '1000.00/paid' AND pg_temp.due(v_t) = '1000.00/0.00/1000.00'
    THEN 'PASS  S5 after the void the tenant can be settled again with a new key (refund due 1,000 again)' ELSE 'FAIL  S5 '||left(v_r,150)||' '||pg_temp.st(v_a)||' '||COALESCE(pg_temp.due(v_t),'null') END;

  ---------------------------------------------------------------- S2 / S3 / S4 refusals
  m := pg_temp.mk_settled('corr2'); v_t := (m->>'tenant')::uuid; v_set := (m->>'settlement')::uuid;
  PERFORM pg_temp.rfp(v_t, 'p7', 200);
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:SETTLEMENT_HAS_PAYOUT%' AND (SELECT voided_at IS NULL FROM move_out_settlements WHERE id = v_set)
    THEN 'PASS  S2 refused while a refund payout is live (void the payout first); settlement untouched' ELSE 'FAIL  S2 '||left(v_r,120) END;

  m := pg_temp.mk_settled('corr3'); v_t := (m->>'tenant')::uuid; v_set := (m->>'settlement')::uuid; v_room := (m->>'room')::uuid;
  INSERT INTO tenants(full_name, move_in_date, room_id, status) VALUES ('New tenant', current_date, v_room, 'active');
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:ROOM_REOCCUPIED%' THEN 'PASS  S3 refused when the room has a new active tenant' ELSE 'FAIL  S3 '||left(v_r,120) END;

  m := pg_temp.mk_settled('corr4'); v_t := (m->>'tenant')::uuid; v_set := (m->>'settlement')::uuid;
  UPDATE invoices SET paid_amount = 100 WHERE id = (m->>'final')::uuid;
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:FINAL_INVOICE_HAS_PAYMENTS%' THEN 'PASS  S4 refused when the final invoice has since been paid' ELSE 'FAIL  S4 '||left(v_r,120) END;

  ---------------------------------------------------------------- S6 atomic: a failing last step rolls everything back
  m := pg_temp.mk_settled('corr5'); v_t := (m->>'tenant')::uuid; v_set := (m->>'settlement')::uuid; v_room := (m->>'room')::uuid; v_a := (m->>'a')::uuid;
  SELECT count(*)::text || '/' || (SELECT count(*) FROM tenant_credits WHERE tenant_id = v_t) || '/' || (SELECT count(*) FROM money_events WHERE tenant_id = v_t)
    || '/' || pg_temp.st(v_a) INTO v_cnt_before FROM invoice_payment_allocations WHERE invoice_id = v_a;
  CREATE FUNCTION public.zz_test_fail_room_update() RETURNS trigger LANGUAGE plpgsql AS $x$
  BEGIN RAISE EXCEPTION 'FORCED_TEST_FAILURE'; END $x$;
  EXECUTE format('CREATE TRIGGER zz_test_fail BEFORE UPDATE ON public.rooms FOR EACH ROW WHEN (OLD.id = %L::uuid) EXECUTE FUNCTION public.zz_test_fail_room_update()', v_room);
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  DROP TRIGGER zz_test_fail ON public.rooms;
  DROP FUNCTION public.zz_test_fail_room_update();
  SELECT count(*)::text || '/' || (SELECT count(*) FROM tenant_credits WHERE tenant_id = v_t) || '/' || (SELECT count(*) FROM money_events WHERE tenant_id = v_t)
    || '/' || pg_temp.st(v_a) INTO v_cnt_after FROM invoice_payment_allocations WHERE invoice_id = v_a;
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:FORCED_TEST_FAILURE%' AND v_cnt_before = v_cnt_after
      AND (SELECT voided_at IS NULL FROM move_out_settlements WHERE id = v_set) AND (SELECT status FROM tenants WHERE id = v_t) = 'inactive'
    THEN 'PASS  S6 forced failure at the last step rolled the whole void back (rows and statuses unchanged: '||v_cnt_after||')'
    ELSE 'FAIL  S6 '||left(v_r,100)||' before='||v_cnt_before||' after='||v_cnt_after END;

  ---------------------------------------------------------------- S7 carry-forward chain: voiding reopens the downstream invoice
  m := pg_temp.mk_settled('corr6', true); v_t := (m->>'tenant')::uuid; v_set := (m->>'settlement')::uuid;
  v_a := (m->>'a')::uuid; v_b := (m->>'b')::uuid;
  v_msg := 'settled: A=' || pg_temp.st(v_a) || ' B=' || pg_temp.st(v_b);
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  v_out := v_out || E'\n' || CASE WHEN v_msg = 'settled: A=1000.00/paid B=1500.00/paid' AND v_r LIKE 'OK:%'
      AND pg_temp.st(v_a) = '0.00/overdue' AND pg_temp.st(v_b) = '1500.00/partial'
    THEN 'PASS  S7 chain: settling A had settled B; voiding the settlement reopens A and B ('||v_msg||' -> A='||pg_temp.st(v_a)||' B='||pg_temp.st(v_b)||')'
    ELSE 'FAIL  S7 '||v_msg||' void='||left(v_r,120)||' A='||pg_temp.st(v_a)||' B='||pg_temp.st(v_b) END;

  ---------------------------------------------------------------- S9 void restores the EXACT pre-settlement state (finding 2)
  m := pg_temp.mk_settled('corr9', false, '2026-10-20', '2026-09-30', true); v_t := (m->>'tenant')::uuid; v_set := (m->>'settlement')::uuid;
  v_room := (m->>'room')::uuid;
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  SELECT status || '/' || COALESCE(room_id::text,'null') || '/' || COALESCE(move_out_date::text,'null') || '/' || forfeit_security_deposit INTO v_msg FROM tenants WHERE id = v_t;
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND v_msg = 'active/' || v_room || '/2026-10-20/true'
      AND (SELECT status FROM move_out_requests WHERE tenant_id = v_t) = 'approved'
      AND (SELECT actual_move_out_date IS NULL FROM move_out_requests WHERE tenant_id = v_t)
      AND (SELECT move_out_date IS NULL FROM room_tenant_logs WHERE tenant_id = v_t)
      AND (SELECT status FROM rooms WHERE id = v_room) = 'occupied'
    THEN 'PASS  S9 void restores the exact original state: move_out_date 2026-10-20 (NOT the request date 2026-09-30), forfeit flag true, request approved, room log open, room occupied'
    ELSE 'FAIL  S9 '||left(v_r,120)||' tenant='||COALESCE(v_msg,'null') END;

  ---------------------------------------------------------------- S10 a settlement with no saved before-state is refused, nothing changes
  m := pg_temp.mk_settled('corr10'); v_t := (m->>'tenant')::uuid; v_set := (m->>'settlement')::uuid;
  ALTER TABLE public.move_out_settlements DISABLE TRIGGER trg_move_out_settlements_guard;
  UPDATE public.move_out_settlements SET tenant_before = NULL WHERE id = v_set;
  ALTER TABLE public.move_out_settlements ENABLE TRIGGER trg_move_out_settlements_guard;
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'ERR:BEFORE_STATE_MISSING%' AND (SELECT voided_at IS NULL FROM move_out_settlements WHERE id = v_set)
      AND (SELECT status FROM tenants WHERE id = v_t) = 'inactive'
    THEN 'PASS  S10 legacy settlement without a saved before-state: void refused with BEFORE_STATE_MISSING, nothing changed' ELSE 'FAIL  S10 '||left(v_r,140) END;

  ---------------------------------------------------------------- S11 later activity is never overwritten (finding 4)
  v_msg := '';
  m := pg_temp.mk_settled('corr11a'); v_t := (m->>'tenant')::uuid; v_set := (m->>'settlement')::uuid;
  INSERT INTO move_out_requests(tenant_id, requested_move_out_date, status, created_at) VALUES (v_t, '2026-12-01', 'requested', now() + interval '1 minute');
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  IF v_r NOT LIKE 'ERR:LATER_ACTIVITY%' THEN v_msg := v_msg || ' later-request:' || left(v_r,60); END IF;

  m := pg_temp.mk_settled('corr11b'); v_t := (m->>'tenant')::uuid; v_set := (m->>'settlement')::uuid; v_room := (m->>'room')::uuid;
  INSERT INTO tenants(full_name, move_in_date, room_id, status) VALUES ('Next tenant', '2026-10-01', NULL, 'inactive') RETURNING id INTO v_a;
  INSERT INTO room_tenant_logs(room_id, tenant_id, tenant_name, move_in_date, move_out_date, created_at) VALUES (v_room, v_a, 'Next', '2026-10-01', '2026-10-10', now() + interval '1 minute');
  INSERT INTO move_out_settlements(tenant_id, room_id, idempotency_key, settlement, created_at) VALUES (v_a, v_room, 'later-room-settlement', '{}'::jsonb, now() + interval '2 minutes');
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  IF v_r NOT LIKE 'ERR:LATER_ACTIVITY%' THEN v_msg := v_msg || ' later-room-settlement:' || left(v_r,60); END IF;
  IF (SELECT voided_at IS NOT NULL FROM move_out_settlements WHERE id = v_set) OR (SELECT status FROM tenants WHERE id = v_t) <> 'inactive' THEN v_msg := v_msg || ' state-changed'; END IF;

  m := pg_temp.mk_settled('corr11c'); v_t := (m->>'tenant')::uuid; v_set := (m->>'settlement')::uuid;
  v_b := pg_temp.ni(v_t, (m->>'room')::uuid, 500, 0, 0, 'pending', '2026-11-05');
  UPDATE invoices SET created_at = now() + interval '1 minute' WHERE id = v_b;
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  IF v_r NOT LIKE 'ERR:LATER_ACTIVITY%' THEN v_msg := v_msg || ' later-invoice:' || left(v_r,60); END IF;

  m := pg_temp.mk_settled('corr11d'); v_t := (m->>'tenant')::uuid; v_set := (m->>'settlement')::uuid;
  UPDATE tenants SET move_out_date = '2026-11-30' WHERE id = v_t;
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  IF v_r NOT LIKE 'ERR:TENANT_STATE_CHANGED%' THEN v_msg := v_msg || ' edited-move-out-date:' || left(v_r,60); END IF;
  v_out := v_out || E'\n' || CASE WHEN v_msg = '' THEN 'PASS  S11 void refused (LATER_ACTIVITY / TENANT_STATE_CHANGED) when a newer move-out request, a later settlement or tenancy in the room, a newer invoice, or an edited move-out date exists; nothing overwritten'
    ELSE 'FAIL  S11 problems:'||v_msg END;

  ---------------------------------------------------------------- S12 an already-voided settlement cannot be voided again
  m := pg_temp.mk_settled('corr12'); v_set := (m->>'settlement')::uuid;
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  v_msg := CASE WHEN v_r LIKE 'OK:%' THEN '' ELSE ' first-void:' || left(v_r,80) END;
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  IF v_r NOT LIKE 'ERR:ALREADY_VOIDED%' THEN v_msg := v_msg || ' second-void-of-same:' || left(v_r,60); END IF;
  v_out := v_out || E'\n' || CASE WHEN v_msg = '' THEN 'PASS  S12 a voided settlement cannot be voided again (ALREADY_VOIDED)' ELSE 'FAIL  S12 '||v_msg END;

  ---------------------------------------------------------------- S13 refund due exists only while the settlement is live (found in the browser run)
  m := pg_temp.mk_settled('corr13'); v_t := (m->>'tenant')::uuid; v_set := (m->>'settlement')::uuid;
  v_msg := pg_temp.due(v_t);
  v_r := pg_temp.try('void_move_out_settlement', jsonb_build_object('settlement_id', v_set, 'reason', 'x', 'actor', 'tester'));
  v_out := v_out || E'\n' || CASE WHEN v_msg = '1000.00/0.00/1000.00' AND v_r LIKE 'OK:%' AND pg_temp.due(v_t) IS NULL
      AND pg_temp.rfp(v_t, 'p13', 10) LIKE 'ERR:NOT_SETTLED%'
      AND (SELECT COALESCE(SUM(amount),0) FROM tenant_credits WHERE tenant_id = v_t AND bucket = 'deposit') = 3000
    THEN 'PASS  S13 refund due 1,000 while settled; after the void the tenant has NO refund-due row although the 3,000 deposit is held again, and a payout is refused (NOT_SETTLED)'
    ELSE 'FAIL  S13 before='||COALESCE(v_msg,'null')||' void='||left(v_r,80)||' after='||COALESCE(pg_temp.due(v_t),'null') END;

  ---------------------------------------------------------------- grants
  SELECT string_agg(f, ',') INTO v_msg FROM (VALUES ('record_refund_payout(jsonb)'), ('void_refund_payout(jsonb)'), ('void_move_out_settlement(jsonb)')) q(f)
   WHERE has_function_privilege('anon', 'public.' || f, 'EXECUTE') OR has_function_privilege('authenticated', 'public.' || f, 'EXECUTE');
  v_out := v_out || E'\n' || CASE WHEN v_msg IS NULL THEN 'PASS  G1 none of the three functions is executable by anon or authenticated' ELSE 'FAIL  G1 '||v_msg END;

  RAISE EXCEPTION 'RESULT:%', v_out;
END
$t$;
