-- Rollback-wrapped tests for public.void_payment_batch().
-- Run ONLY on the dummy project dorm-test (rghxelkifdrpvabyxopb). Never on production.
-- Nothing persists: the DO block ends with RAISE EXCEPTION 'RESULT: ...' (the pg_temp helper dies with the session/transaction).
-- Case statuses: PASS | FAIL (see 01_record_payment_batch.sql). Former KNOWN-GAP (finding 44) and the
-- probes for findings 105/108 are now ordinary assertions.

-- Helper: records one payment through record_payment_batch. Returns the batch id.
CREATE OR REPLACE FUNCTION pg_temp.rp(p_tenant uuid, p_inv uuid, p_received numeric, p_alloc numeric,
                                      p_new_paid numeric, p_status text, p_expected numeric, p_key text,
                                      p_slip text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_id uuid := gen_random_uuid(); v_len int;
BEGIN
  SELECT jsonb_array_length(payment_history) INTO v_len FROM public.invoices WHERE id = p_inv;
  PERFORM public.record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', v_id, 'tenant_id', p_tenant, 'trigger_invoice_id', p_inv, 'amount_received', p_received,
              'amount_allocated', p_alloc, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key',p_key,
              'created_by','tester', 'slip_url', p_slip),
    'invoices', jsonb_build_array(jsonb_build_object('id', p_inv, 'expected_paid_amount', p_expected, 'expected_history_length', v_len,
              'paid_amount', p_new_paid, 'status', p_status)),
    'allocations', jsonb_build_array(jsonb_build_object('invoice_id', p_inv, 'amount', p_alloc))));
  RETURN v_id;
END $f$;

-- Helper: new invoice for the tenant.
CREATE OR REPLACE FUNCTION pg_temp.ni(p_tenant uuid, p_room uuid, p_total numeric, p_due date)
RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO public.invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
  VALUES (p_tenant, p_room, current_date, p_due, current_date, current_date, p_total, 'pending') RETURNING id
$f$;

DO $t$
DECLARE
  v_out text := '';
  v_room uuid; v_ta uuid;
  v_a uuid; v_b uuid; v_c uuid;
  v_b1 uuid; v_b2 uuid; v_res jsonb; v_n int; v_n2 int; v_num numeric; v_msg text; v_st text;
  v_due date := current_date + 30;
BEGIN
  INSERT INTO rooms(room_number) VALUES ('T-'||gen_random_uuid()) RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id) VALUES ('Void Test', current_date, v_room) RETURNING id INTO v_ta;

  ---------------------------------------------------------------- V1 normal void (2 invoices) + V6 event rows
  v_a := pg_temp.ni(v_ta, v_room, 1000, v_due);
  v_b := pg_temp.ni(v_ta, v_room, 2000, v_due);
  v_b1 := gen_random_uuid();
  PERFORM record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', v_b1, 'tenant_id', v_ta, 'trigger_invoice_id', v_b, 'amount_received', 2500, 'amount_allocated', 2500,
              'paid_at', now(), 'mode','manual','source','cash','idempotency_key','v1','created_by','tester'),
    'invoices', jsonb_build_array(
      jsonb_build_object('id', v_a, 'expected_paid_amount', 0, 'expected_history_length', 0, 'paid_amount', 1000, 'status','paid'),
      jsonb_build_object('id', v_b, 'expected_paid_amount', 0, 'expected_history_length', 0, 'paid_amount', 1500, 'status','partial')),
    'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_a, 'amount', 1000), jsonb_build_object('invoice_id', v_b, 'amount', 1500))));
  v_res := void_payment_batch(v_b1, E'  wrong amount entered\n', 'tester');
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
    THEN 'PASS  V1 normal void, reason stored trimmed ('||v_msg||')' ELSE 'FAIL  V1 normal void ('||v_msg||')' END;
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

  ---------------------------------------------------------------- V3 blank reason (finding 105)
  v_b2 := pg_temp.rp(v_ta, v_a, 100, 100, 100, 'partial', 0, 'v3');
  FOR v_st IN SELECT unnest(ARRAY['', '   ', E'\t\n', E'\r\n \t']) LOOP
    BEGIN
      PERFORM void_payment_batch(v_b2, v_st, 'tester');
      v_out := v_out || E'\n' || 'FAIL  V3 blank reason ['||replace(replace(replace(v_st,E'\t','\t'),E'\n','\n'),E'\r','\r')||'] accepted';
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || E'\n' || CASE WHEN SQLERRM = 'A reason is required to void a payment'
        THEN 'PASS  V3 blank reason ['||replace(replace(replace(v_st,E'\t','\t'),E'\n','\n'),E'\r','\r')||'] rejected'
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
  BEGIN
    UPDATE payment_batches SET voided_at = now(), void_reason = E'\t' WHERE id = v_b2;
    v_out := v_out || E'\n' || 'FAIL  V3c direct UPDATE with tab-only void_reason accepted';
  EXCEPTION WHEN check_violation THEN
    v_out := v_out || E'\n' || 'PASS  V3c payment_batches_void_reason_check blocks a blank void_reason on direct UPDATE';
  END;

  ---------------------------------------------------------------- V4 unknown batch
  BEGIN
    PERFORM void_payment_batch(gen_random_uuid(), 'x', 'tester');
    v_out := v_out || E'\n' || 'FAIL  V4 unknown batch accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM='Payment batch not found' THEN 'PASS  V4 unknown batch rejected ('||SQLERRM||')' ELSE 'FAIL  V4 wrong error '||SQLERRM END;
  END;

  ---------------------------------------------------------------- V5 status downgrade partial/paid
  v_c := pg_temp.ni(v_ta, v_room, 1000, v_due);
  v_b1 := pg_temp.rp(v_ta, v_c, 600, 600, 600, 'partial', 0, 'v5a');
  v_b2 := pg_temp.rp(v_ta, v_c, 400, 400, 1000, 'paid', 600, 'v5b');
  PERFORM void_payment_batch(v_b2, 'bounced', 'tester');
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_c;
  v_out := v_out || E'\n' || CASE WHEN v_st='600.00/partial' THEN 'PASS  V5a paid -> partial after voiding the 400 batch ('||v_st||')' ELSE 'FAIL  V5a got '||v_st END;
  PERFORM void_payment_batch(v_b1, 'bounced too', 'tester');
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_c;
  v_out := v_out || E'\n' || CASE WHEN v_st='0.00/pending' THEN 'PASS  V5b partial -> pending after voiding the rest ('||v_st||')' ELSE 'FAIL  V5b got '||v_st END;

  -- V5c: past due date -> overdue, not pending
  v_c := pg_temp.ni(v_ta, v_room, 500, current_date - 10);
  v_b1 := pg_temp.rp(v_ta, v_c, 500, 500, 500, 'paid', 0, 'v5c');
  PERFORM void_payment_batch(v_b1, 'bounced', 'tester');
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_c;
  v_out := v_out || E'\n' || CASE WHEN v_st='0.00/overdue' THEN 'PASS  V5c paid -> overdue when the due date has passed ('||v_st||')' ELSE 'FAIL  V5c got '||v_st END;

  ---------------------------------------------------------------- V7 finding 44: overpayment credit reversed
  v_c := pg_temp.ni(v_ta, v_room, 700, v_due);
  v_b1 := pg_temp.rp(v_ta, v_c, 1000, 700, 700, 'paid', 0, 'v7');
  v_res := void_payment_batch(v_b1, 'receipt was fake', 'tester');
  SELECT COALESCE(sum(amount),0) INTO v_num FROM tenant_credits WHERE payment_batch_id = v_b1;
  SELECT count(*) INTO v_n FROM tenant_credits r JOIN tenant_credits o ON o.id = r.reverses_credit_id
   WHERE r.payment_batch_id = v_b1 AND r.kind='reversal' AND r.bucket='unapplied' AND r.amount = -o.amount AND o.kind='overpayment'
     AND r.reason LIKE '%receipt was fake%' AND r.actor='tester';
  SELECT count(*) INTO v_n2 FROM money_events WHERE payment_batch_id = v_b1 AND action='credit.reversal';
  v_out := v_out || E'\n' || CASE WHEN v_num = 0 AND v_n = 1 AND v_n2 = 1 AND (v_res->>'credit_reversed')::numeric = 300
    THEN 'PASS  V7 (finding 44) void reverses the 300 overpayment credit with one linked reversal row + credit.reversal event (net 0)'
    ELSE 'FAIL  V7 net='||v_num||' linked_reversals='||v_n||' events='||v_n2||' res='||v_res::text END;
  SELECT unapplied_credit INTO v_num FROM tenant_credit_balances WHERE tenant_id = v_ta;
  v_out := v_out || E'\n' || CASE WHEN v_num = 0 THEN 'PASS  V7b tenant_credit_balances.unapplied_credit back to 0' ELSE 'FAIL  V7b unapplied='||v_num END;
  -- V7c: the same credit row cannot be reversed twice, even by a direct insert
  BEGIN
    INSERT INTO tenant_credits(tenant_id, kind, bucket, amount, payment_batch_id, reason, reverses_credit_id)
      SELECT tenant_id, 'reversal', 'unapplied', -amount, payment_batch_id, 'second reversal', id
      FROM tenant_credits WHERE payment_batch_id = v_b1 AND kind = 'overpayment';
    v_out := v_out || E'\n' || 'FAIL  V7c second reversal of the same credit accepted';
  EXCEPTION WHEN unique_violation THEN
    v_out := v_out || E'\n' || 'PASS  V7c second reversal of the same credit blocked (uq_tenant_credits_single_reversal)';
  END;
  -- V7d: credit already spent -> void refused, nothing written
  v_c := pg_temp.ni(v_ta, v_room, 700, v_due);
  v_b1 := pg_temp.rp(v_ta, v_c, 1000, 700, 700, 'paid', 0, 'v7d');
  INSERT INTO tenant_credits(tenant_id, kind, bucket, amount, invoice_id, reason) VALUES (v_ta, 'applied_to_invoice', 'unapplied', -300, v_a, 'used on another invoice');
  BEGIN
    PERFORM void_payment_batch(v_b1, 'bounced', 'tester');
    v_out := v_out || E'\n' || 'FAIL  V7d void accepted although its credit was already spent';
  EXCEPTION WHEN OTHERS THEN
    SELECT count(*) INTO v_n FROM invoice_payment_allocations WHERE payment_batch_id = v_b1;
    SELECT paid_amount INTO v_num FROM invoices WHERE id = v_c;
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'VOID_CREDIT_ALREADY_USED%' AND v_n = 1 AND v_num = 700
      THEN 'PASS  V7d void refused when the overpayment credit was already spent ('||left(SQLERRM,90)||'...; nothing written)'
      ELSE 'FAIL  V7d msg='||SQLERRM||' allocs='||v_n||' paid='||v_num END;
  END;

  ---------------------------------------------------------------- V8 finding 108: never below zero
  v_c := pg_temp.ni(v_ta, v_room, 500, v_due);
  v_b1 := pg_temp.rp(v_ta, v_c, 500, 500, 500, 'paid', 0, 'v8');
  UPDATE invoices SET paid_amount = 200 WHERE id = v_c;  -- someone edited paid_amount after the receipt
  BEGIN
    PERFORM void_payment_batch(v_b1, 'negative?', 'tester');
    v_out := v_out || E'\n' || 'FAIL  V8 void accepted and would drive paid_amount negative';
  EXCEPTION WHEN OTHERS THEN
    SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_c;
    SELECT count(*) INTO v_n FROM invoice_payment_allocations WHERE payment_batch_id = v_b1;
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'VOID_WOULD_MAKE_NEGATIVE invoice '||v_c||'%' AND v_st = '200.00/paid' AND v_n = 1
      THEN 'PASS  V8 (finding 108) void refused, error names the invoice, nothing written ('||left(SQLERRM,70)||'...)'
      ELSE 'FAIL  V8 msg='||SQLERRM||' state='||v_st||' allocs='||v_n END;
  END;

  ---------------------------------------------------------------- V9 finding 108: verifying
  -- V9a: a different slip is awaiting review -> stay verifying
  v_c := pg_temp.ni(v_ta, v_room, 500, v_due);
  v_b1 := pg_temp.rp(v_ta, v_c, 500, 500, 500, 'paid', 0, 'v9a');
  UPDATE invoices SET status = 'verifying', slip_url = 'https://example.test/new-slip.png' WHERE id = v_c;
  PERFORM void_payment_batch(v_b1, 'cash receipt was wrong', 'tester');
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_c;
  v_out := v_out || E'\n' || CASE WHEN v_st='0.00/verifying' THEN 'PASS  V9a verifying with a slip awaiting review stays verifying ('||v_st||')' ELSE 'FAIL  V9a got '||v_st END;
  -- V9b: no slip awaiting review -> downgraded like paid/partial
  v_c := pg_temp.ni(v_ta, v_room, 500, v_due);
  v_b1 := pg_temp.rp(v_ta, v_c, 500, 500, 500, 'paid', 0, 'v9b');
  UPDATE invoices SET status = 'verifying', slip_url = NULL WHERE id = v_c;
  PERFORM void_payment_batch(v_b1, 'probe verifying', 'tester');
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_c;
  v_out := v_out || E'\n' || CASE WHEN v_st='0.00/pending' THEN 'PASS  V9b verifying without a pending slip downgrades ('||v_st||')' ELSE 'FAIL  V9b got '||v_st END;
  -- V9c: the slip on the invoice IS the voided receipt's slip -> not "awaiting", downgrade
  v_c := pg_temp.ni(v_ta, v_room, 500, v_due);
  v_b1 := pg_temp.rp(v_ta, v_c, 500, 500, 500, 'paid', 0, 'v9c', 'https://example.test/slip-v9c.png');
  UPDATE invoices SET status = 'verifying', slip_url = 'https://example.test/slip-v9c.png' WHERE id = v_c;
  PERFORM void_payment_batch(v_b1, 'slip was fake', 'tester');
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_c;
  v_out := v_out || E'\n' || CASE WHEN v_st='0.00/pending' THEN 'PASS  V9c verifying on the voided receipt''s own slip downgrades ('||v_st||')' ELSE 'FAIL  V9c got '||v_st END;

  ---------------------------------------------------------------- V10 cancelled is not reopened
  v_c := pg_temp.ni(v_ta, v_room, 500, v_due);
  v_b1 := pg_temp.rp(v_ta, v_c, 300, 300, 300, 'partial', 0, 'v10');
  UPDATE invoices SET status = 'cancelled' WHERE id = v_c;
  PERFORM void_payment_batch(v_b1, 'refund outside system', 'tester');
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_c;
  SELECT count(*) INTO v_n FROM money_events WHERE payment_batch_id = v_b1 AND action='payment.void' AND (after->>'status_kept')::boolean;
  v_out := v_out || E'\n' || CASE WHEN v_st='0.00/cancelled' AND v_n = 1 THEN 'PASS  V10 cancelled invoice stays cancelled after void, flagged status_kept in the event ('||v_st||')' ELSE 'FAIL  V10 got '||v_st||' kept_events='||v_n END;

  ---------------------------------------------------------------- V11 grants
  SELECT string_agg(r, ',') INTO v_st FROM unnest(ARRAY['anon','authenticated']) r
   WHERE has_function_privilege(r, 'public.void_payment_batch(uuid,text,text)', 'EXECUTE');
  v_out := v_out || E'\n' || CASE WHEN v_st IS NULL AND has_function_privilege('service_role', 'public.void_payment_batch(uuid,text,text)', 'EXECUTE')
    THEN 'PASS  V11 only service_role can execute void_payment_batch' ELSE 'FAIL  V11 executable by '||COALESCE(v_st,'?') END;

  RAISE EXCEPTION 'RESULT:%', v_out;
END
$t$;
