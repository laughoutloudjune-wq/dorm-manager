-- Rollback-wrapped tests for public.void_payment_batch().
-- Run ONLY on the dummy project dorm-test (rghxelkifdrpvabyxopb). Never on production.
-- Nothing persists: the DO block ends with RAISE EXCEPTION 'RESULT: ...' (the pg_temp helper dies with the session/transaction).
-- Case statuses: PASS | FAIL | KNOWN-GAP | UNEXPECTED-PASS | PROBE (see 01_record_payment_batch.sql).

-- Helper: records one payment through record_payment_batch. Returns the batch id.
CREATE OR REPLACE FUNCTION pg_temp.rp(p_tenant uuid, p_inv uuid, p_received numeric, p_alloc numeric,
                                      p_new_paid numeric, p_status text, p_expected numeric, p_key text)
RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  PERFORM public.record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', v_id, 'tenant_id', p_tenant, 'trigger_invoice_id', p_inv, 'amount_received', p_received,
              'amount_allocated', p_alloc, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key',p_key,'created_by','tester'),
    'invoices', jsonb_build_array(jsonb_build_object('id', p_inv, 'expected_paid_amount', p_expected, 'paid_amount', p_new_paid, 'status', p_status)),
    'allocations', jsonb_build_array(jsonb_build_object('invoice_id', p_inv, 'amount', p_alloc))));
  RETURN v_id;
END $f$;

DO $t$
DECLARE
  v_out text := '';
  v_room uuid; v_ta uuid;
  v_a uuid; v_b uuid; v_c uuid;
  v_b1 uuid; v_b2 uuid; v_res jsonb; v_n int; v_n2 int; v_num numeric; v_msg text; v_st text;
BEGIN
  INSERT INTO rooms(room_number) VALUES ('T-'||gen_random_uuid()) RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id) VALUES ('Void Test', current_date, v_room) RETURNING id INTO v_ta;

  ---------------------------------------------------------------- V1 normal void (2 invoices) + V6 event rows
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_ta, v_room, current_date, current_date, current_date, current_date, 1000, 'pending') RETURNING id INTO v_a;
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_ta, v_room, current_date, current_date, current_date, current_date, 2000, 'pending') RETURNING id INTO v_b;
  v_b1 := gen_random_uuid();
  PERFORM record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', v_b1, 'tenant_id', v_ta, 'trigger_invoice_id', v_b, 'amount_received', 2500, 'amount_allocated', 2500,
              'paid_at', now(), 'mode','manual','source','cash','idempotency_key','v1','created_by','tester'),
    'invoices', jsonb_build_array(
      jsonb_build_object('id', v_a, 'expected_paid_amount', 0, 'paid_amount', 1000, 'status','paid'),
      jsonb_build_object('id', v_b, 'expected_paid_amount', 0, 'paid_amount', 1500, 'status','partial')),
    'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_a, 'amount', 1000), jsonb_build_object('invoice_id', v_b, 'amount', 1500))));
  v_res := void_payment_batch(v_b1, 'wrong amount entered', 'tester');
  v_msg := 'res.voided='||(v_res->>'voided')||' reversed='||(v_res->>'reversed_allocations');
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_a; v_msg := v_msg||' A='||v_st;
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_b; v_msg := v_msg||' B='||v_st;
  SELECT count(*) INTO v_n FROM invoice_payment_allocations WHERE payment_batch_id = v_b1 AND amount > 0;
  SELECT count(*) INTO v_n2 FROM invoice_payment_allocations r JOIN invoice_payment_allocations o ON o.id = r.reverses_allocation_id
    WHERE r.payment_batch_id = v_b1 AND r.amount = -o.amount AND r.source='void';
  v_msg := v_msg||' originals_kept='||v_n||' reversals='||v_n2;
  SELECT COALESCE(sum(amount),0) INTO v_num FROM invoice_payment_allocations WHERE payment_batch_id = v_b1; v_msg := v_msg||' net_alloc='||v_num::numeric(12,2);
  SELECT (voided_at IS NOT NULL)||'/'||void_reason||'/'||voided_by INTO v_st FROM payment_batches WHERE id = v_b1; v_msg := v_msg||' batch='||v_st;
  v_out := v_out || E'\n' || CASE WHEN v_msg = 'res.voided=true reversed=2 A=0.00/pending B=0.00/pending originals_kept=2 reversals=2 net_alloc=0.00 batch=true/wrong amount entered/tester'
    THEN 'PASS  V1 normal void ('||v_msg||')' ELSE 'FAIL  V1 normal void ('||v_msg||')' END;
  SELECT count(*) INTO v_n FROM money_events WHERE payment_batch_id = v_b1 AND action='payment.void' AND reason='wrong amount entered' AND actor_user_id='tester';
  SELECT count(*) INTO v_n2 FROM money_events WHERE payment_batch_id = v_b1 AND action='payment.record';
  v_out := v_out || E'\n' || CASE WHEN v_n=2 AND v_n2=1 THEN 'PASS  V6 event rows written (1 payment.record + 2 payment.void with reason+actor)'
    ELSE 'FAIL  V6 events void='||v_n||' record='||v_n2 END;
  SELECT count(*) INTO v_n FROM invoices WHERE id IN (v_a,v_b) AND payment_history @> '[{"type":"void"}]'::jsonb;
  v_out := v_out || E'\n' || CASE WHEN v_n=2 THEN 'PASS  V1b void entry appended to payment_history on both invoices' ELSE 'FAIL  V1b history void entries='||v_n END;

  ---------------------------------------------------------------- V2 double void
  BEGIN
    PERFORM void_payment_batch(v_b1, 'again', 'tester');
    v_out := v_out || E'\n' || 'FAIL  V2 second void accepted';
  EXCEPTION WHEN OTHERS THEN
    SELECT count(*) INTO v_n FROM invoice_payment_allocations WHERE payment_batch_id = v_b1;
    v_out := v_out || E'\n' || CASE WHEN SQLERRM = 'Payment batch already voided' AND v_n=4 THEN 'PASS  V2 double void rejected ('||SQLERRM||'; allocation rows still 4)'
      ELSE 'FAIL  V2 msg='||SQLERRM||' alloc_rows='||v_n END;
  END;

  ---------------------------------------------------------------- V3 blank reason
  v_b2 := pg_temp.rp(v_ta, v_a, 100, 100, 100, 'partial', 0, 'v3');
  FOR v_st IN SELECT unnest(ARRAY['', '   ', E'\t\n']) LOOP
    BEGIN
      PERFORM void_payment_batch(v_b2, v_st, 'tester');
      v_out := v_out || E'\n' || 'FAIL  V3 blank reason ['||replace(replace(v_st,E'\t','\t'),E'\n','\n')||'] accepted';
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || E'\n' || CASE WHEN SQLERRM = 'A reason is required to void a payment' THEN 'PASS  V3 blank reason rejected ('||SQLERRM||')'
        ELSE 'FAIL  V3 wrong error '||SQLERRM END;
    END;
  END LOOP;
  BEGIN
    PERFORM void_payment_batch(v_b2, NULL, 'tester');
    v_out := v_out || E'\n' || 'FAIL  V3 NULL reason accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || 'PASS  V3 NULL reason rejected ('||SQLERRM||')';
  END;
  SELECT (voided_at IS NULL)::text INTO v_st FROM payment_batches WHERE id = v_b2;
  v_out := v_out || E'\n' || CASE WHEN v_st='true' THEN 'PASS  V3b batch untouched after rejected voids' ELSE 'FAIL  V3b batch voided despite blank reason' END;

  ---------------------------------------------------------------- V4 unknown batch
  BEGIN
    PERFORM void_payment_batch(gen_random_uuid(), 'x', 'tester');
    v_out := v_out || E'\n' || 'FAIL  V4 unknown batch accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM='Payment batch not found' THEN 'PASS  V4 unknown batch rejected ('||SQLERRM||')' ELSE 'FAIL  V4 wrong error '||SQLERRM END;
  END;

  ---------------------------------------------------------------- V5 status downgrade partial/paid
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_ta, v_room, current_date, current_date, current_date, current_date, 1000, 'pending') RETURNING id INTO v_c;
  v_b1 := pg_temp.rp(v_ta, v_c, 600, 600, 600, 'partial', 0, 'v5a');
  v_b2 := pg_temp.rp(v_ta, v_c, 400, 400, 1000, 'paid', 600, 'v5b');
  PERFORM void_payment_batch(v_b2, 'bounced', 'tester');
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_c;
  v_out := v_out || E'\n' || CASE WHEN v_st='600.00/partial' THEN 'PASS  V5a paid -> partial after voiding the 400 batch ('||v_st||')' ELSE 'FAIL  V5a got '||v_st END;
  PERFORM void_payment_batch(v_b1, 'bounced too', 'tester');
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_c;
  v_out := v_out || E'\n' || CASE WHEN v_st='0.00/pending' THEN 'PASS  V5b partial -> pending after voiding the rest ('||v_st||')' ELSE 'FAIL  V5b got '||v_st END;

  ---------------------------------------------------------------- V7 KNOWN GAP finding 44: overpayment credit not reversed
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_ta, v_room, current_date, current_date, current_date, current_date, 700, 'pending') RETURNING id INTO v_c;
  v_b1 := pg_temp.rp(v_ta, v_c, 1000, 700, 700, 'paid', 0, 'v7');
  PERFORM void_payment_batch(v_b1, 'receipt was fake', 'tester');
  SELECT COALESCE(sum(amount),0) INTO v_num FROM tenant_credits WHERE payment_batch_id = v_b1;
  SELECT count(*) INTO v_n FROM tenant_credits WHERE payment_batch_id = v_b1 AND kind='reversal';
  IF v_num = 0 AND v_n >= 1 THEN
    v_out := v_out || E'\n' || 'UNEXPECTED-PASS  V7 (finding 44) overpayment credit reversed on void (net credit 0) -> gap appears fixed';
  ELSE
    v_out := v_out || E'\n' || 'KNOWN-GAP  V7 (finding 44) voided an overpaid receipt; tenant_credits for that batch still net '||v_num||' with '||v_n||' reversal rows (orphan credit)';
  END IF;

  ---------------------------------------------------------------- Probes (observation only)
  -- P1: paid_amount manually lowered below the allocation, then void -> negative paid_amount?
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_ta, v_room, current_date, current_date, current_date, current_date, 500, 'pending') RETURNING id INTO v_c;
  v_b1 := pg_temp.rp(v_ta, v_c, 500, 500, 500, 'paid', 0, 'p1');
  UPDATE invoices SET paid_amount = 200 WHERE id = v_c;  -- someone edited paid_amount after the receipt
  PERFORM void_payment_batch(v_b1, 'probe negative', 'tester');
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_c;
  v_out := v_out || E'\n' || 'PROBE  P1 void of a 500 allocation when invoice paid_amount was edited to 200 -> stored '||v_st||CASE WHEN v_st LIKE '-%' THEN ' (NEGATIVE paid_amount accepted, no floor / no drift check)' ELSE '' END;

  -- P2: void of a batch on a cancelled invoice: status handling.
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_ta, v_room, current_date, current_date, current_date, current_date, 500, 'pending') RETURNING id INTO v_c;
  v_b1 := pg_temp.rp(v_ta, v_c, 500, 500, 500, 'paid', 0, 'p2');
  UPDATE invoices SET status = 'verifying' WHERE id = v_c;
  PERFORM void_payment_batch(v_b1, 'probe verifying', 'tester');
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_c;
  v_out := v_out || E'\n' || 'PROBE  P2 void when invoice status is verifying (paid_amount 500 -> 0) -> stored '||v_st||CASE WHEN v_st LIKE '%verifying' THEN ' (status left as verifying)' ELSE '' END;

  -- P3: void of a batch that has a different tenant_id than the invoice (finding 35 consequence): credit/events attribute to batch tenant.
  RAISE EXCEPTION 'RESULT:%', v_out;
END
$t$;
