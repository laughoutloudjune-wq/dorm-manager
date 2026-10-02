-- Rollback-wrapped tests for public.record_payment_batch().
-- Run ONLY on the dummy project dorm-test (rghxelkifdrpvabyxopb). Never on production.
-- Nothing persists: the block ends with RAISE EXCEPTION 'RESULT: ...' which rolls everything back.
-- Case statuses: PASS | FAIL | KNOWN-GAP (fails today by design, see finding) |
--                UNEXPECTED-PASS (a known gap now passes - gap fixed, update the test) | PROBE (observation, no verdict)
DO $t$
DECLARE
  v_out text := '';
  v_room uuid; v_ta uuid; v_tb uuid;
  v_a uuid; v_b uuid; v_c uuid;
  v_bid uuid; v_res jsonb; v_n int; v_num numeric; v_msg text; v_st text;
  v_ph jsonb;
BEGIN
  INSERT INTO rooms(room_number) VALUES ('T-'||gen_random_uuid()) RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id) VALUES ('Test A', current_date, v_room) RETURNING id INTO v_ta;
  INSERT INTO tenants(full_name, move_in_date, room_id, status) VALUES ('Test B', current_date, v_room, 'inactive') RETURNING id INTO v_tb;

  ---------------------------------------------------------------- R1 normal multi-invoice
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_ta, v_room, current_date, current_date, current_date, current_date, 1000, 'pending') RETURNING id INTO v_a;
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_ta, v_room, current_date, current_date, current_date, current_date, 2000, 'pending') RETURNING id INTO v_b;
  v_bid := gen_random_uuid();
  v_res := record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', v_bid, 'tenant_id', v_ta, 'trigger_invoice_id', v_b, 'amount_received', 2500,
              'amount_allocated', 2500, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key','r1-key','created_by','tester'),
    'invoices', jsonb_build_array(
      jsonb_build_object('id', v_a, 'expected_paid_amount', 0, 'paid_amount', 1000, 'status','paid','payment_history','[{"x":1}]'::jsonb),
      jsonb_build_object('id', v_b, 'expected_paid_amount', 0, 'paid_amount', 1500, 'status','partial','payment_history','[{"x":2}]'::jsonb)),
    'allocations', jsonb_build_array(
      jsonb_build_object('invoice_id', v_a, 'amount', 1000, 'source','cash'),
      jsonb_build_object('invoice_id', v_b, 'amount', 1500, 'source','cash'))));
  SELECT count(*) INTO v_n FROM payment_batches WHERE id = v_bid;
  v_msg := 'batch='||v_n;
  SELECT count(*) INTO v_n FROM invoice_payment_allocations WHERE payment_batch_id = v_bid; v_msg := v_msg||' allocs='||v_n;
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_a; v_msg := v_msg||' A='||v_st;
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_b; v_msg := v_msg||' B='||v_st;
  SELECT count(*) INTO v_n FROM money_events WHERE payment_batch_id = v_bid AND action='payment.record'; v_msg := v_msg||' events='||v_n;
  SELECT count(*) INTO v_n FROM tenant_credits WHERE payment_batch_id = v_bid; v_msg := v_msg||' credits='||v_n;
  v_out := v_out || E'\n' || CASE WHEN (v_res->>'replayed')='false' AND v_msg = 'batch=1 allocs=2 A=1000.00/paid B=1500.00/partial events=1 credits=0'
    THEN 'PASS  R1 normal multi-invoice payment ('||v_msg||')' ELSE 'FAIL  R1 normal multi-invoice payment ('||v_msg||' res='||v_res::text||')' END;

  ---------------------------------------------------------------- R2 idempotent replay
  v_res := record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', gen_random_uuid(), 'tenant_id', v_ta, 'trigger_invoice_id', v_b, 'amount_received', 2500,
              'amount_allocated', 2500, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key','r1-key','created_by','tester'),
    'invoices', jsonb_build_array(jsonb_build_object('id', v_a, 'expected_paid_amount', 0, 'paid_amount', 1000, 'status','paid')),
    'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_a, 'amount', 2500))));
  SELECT count(*) INTO v_n FROM payment_batches WHERE trigger_invoice_id = v_b AND idempotency_key='r1-key';
  v_msg := 'replayed='||(v_res->>'replayed')||' same_id='||((v_res->>'payment_batch_id')::uuid = v_bid)||' batches='||v_n;
  SELECT count(*) INTO v_n FROM invoice_payment_allocations WHERE payment_batch_id = v_bid; v_msg := v_msg||' allocs='||v_n;
  SELECT paid_amount INTO v_num FROM invoices WHERE id = v_a; v_msg := v_msg||' A.paid='||v_num::numeric(12,2);
  v_out := v_out || E'\n' || CASE WHEN v_msg = 'replayed=true same_id=true batches=1 allocs=2 A.paid=1000.00'
    THEN 'PASS  R2 idempotent replay same key ('||v_msg||')' ELSE 'FAIL  R2 idempotent replay same key ('||v_msg||')' END;

  ---------------------------------------------------------------- R3 race simulation (unique-violation path)
  -- A true two-session race cannot run inside one transaction. We force the INSERT to hit a unique
  -- violation while the idempotency pre-check misses: reuse an existing batch PRIMARY KEY with a NEW key.
  -- The handler then looks up by (trigger, key), finds nothing, and must re-raise (not swallow).
  BEGIN
    PERFORM record_payment_batch(jsonb_build_object(
      'batch', jsonb_build_object('id', v_bid, 'tenant_id', v_ta, 'trigger_invoice_id', v_b, 'amount_received', 10,
                'amount_allocated', 0, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key','r3-other-key','created_by','tester'),
      'invoices','[]'::jsonb,'allocations','[]'::jsonb));
    v_out := v_out || E'\n' || 'FAIL  R3 unique-violation path: no error raised (duplicate batch id accepted)';
  EXCEPTION WHEN unique_violation THEN
    v_out := v_out || E'\n' || 'PASS  R3 unique-violation path re-raises when no idempotent winner exists (SQLSTATE 23505). NOTE: same-key two-session race (replay-from-handler branch) is NOT exercisable single-session; needs two connections.';
  WHEN OTHERS THEN
    v_out := v_out || E'\n' || 'FAIL  R3 unexpected error: '||SQLERRM;
  END;

  ---------------------------------------------------------------- R4 STALE_INVOICE on changed paid_amount
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, paid_amount, status)
    VALUES (v_ta, v_room, current_date, current_date, current_date, current_date, 1000, 300, 'partial') RETURNING id INTO v_c;
  BEGIN
    PERFORM record_payment_batch(jsonb_build_object(
      'batch', jsonb_build_object('id', gen_random_uuid(), 'tenant_id', v_ta, 'trigger_invoice_id', v_c, 'amount_received', 700,
                'amount_allocated', 700, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key','r4-key','created_by','tester'),
      'invoices', jsonb_build_array(jsonb_build_object('id', v_c, 'expected_paid_amount', 0, 'paid_amount', 700, 'status','partial')),
      'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_c, 'amount', 700))));
    v_out := v_out || E'\n' || 'FAIL  R4 STALE_INVOICE: stale expected_paid_amount accepted';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    SELECT count(*) INTO v_n FROM payment_batches WHERE idempotency_key='r4-key';
    SELECT paid_amount INTO v_num FROM invoices WHERE id = v_c;
    v_out := v_out || E'\n' || CASE WHEN v_msg LIKE 'STALE_INVOICE%' AND v_n=0 AND v_num=300
      THEN 'PASS  R4 STALE_INVOICE ('||v_msg||'; nothing written)' ELSE 'FAIL  R4 STALE_INVOICE msg='||v_msg||' batches='||v_n||' paid='||v_num END;
  END;

  ---------------------------------------------------------------- R5 allocation sum != amount_allocated
  BEGIN
    PERFORM record_payment_batch(jsonb_build_object(
      'batch', jsonb_build_object('id', gen_random_uuid(), 'tenant_id', v_ta, 'trigger_invoice_id', v_c, 'amount_received', 700,
                'amount_allocated', 700, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key','r5-key','created_by','tester'),
      'invoices', jsonb_build_array(jsonb_build_object('id', v_c, 'expected_paid_amount', 300, 'paid_amount', 1000, 'status','paid')),
      'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_c, 'amount', 600))));
    v_out := v_out || E'\n' || 'FAIL  R5 allocation sum mismatch accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE '%do not equal amount_allocated%' THEN 'PASS  R5 allocation sum mismatch rejected ('||SQLERRM||')'
      ELSE 'FAIL  R5 wrong error: '||SQLERRM END;
  END;

  ---------------------------------------------------------------- R6 overpayment -> exactly one credit row
  v_bid := gen_random_uuid();
  PERFORM record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', v_bid, 'tenant_id', v_ta, 'trigger_invoice_id', v_c, 'amount_received', 1000,
              'amount_allocated', 700, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key','r6-key','created_by','tester'),
    'invoices', jsonb_build_array(jsonb_build_object('id', v_c, 'expected_paid_amount', 300, 'paid_amount', 1000, 'status','paid')),
    'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_c, 'amount', 700))));
  SELECT count(*), COALESCE(sum(amount),0) INTO v_n, v_num FROM tenant_credits WHERE payment_batch_id = v_bid AND kind='overpayment' AND bucket='unapplied';
  SELECT count(*)::text INTO v_msg FROM tenant_credits WHERE payment_batch_id = v_bid;
  v_out := v_out || E'\n' || CASE WHEN v_n=1 AND v_num=300 AND v_msg::int=1 THEN 'PASS  R6 overpayment creates exactly one overpayment credit (300)'
    ELSE 'FAIL  R6 overpayment credits='||v_n||' sum='||v_num||' total_rows='||v_msg END;
  -- replaying the same key must not add a second credit
  PERFORM record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', gen_random_uuid(), 'tenant_id', v_ta, 'trigger_invoice_id', v_c, 'amount_received', 1000,
              'amount_allocated', 700, 'paid_at', now(), 'idempotency_key','r6-key'),
    'invoices','[]'::jsonb,'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_c, 'amount', 700))));
  SELECT count(*) INTO v_n FROM tenant_credits WHERE payment_batch_id = v_bid;
  v_out := v_out || E'\n' || CASE WHEN v_n=1 THEN 'PASS  R6b replay of overpaid receipt adds no second credit' ELSE 'FAIL  R6b credits after replay='||v_n END;

  ---------------------------------------------------------------- R7 KNOWN GAP finding 35: invoice of another tenant
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_tb, v_room, current_date, current_date, current_date, current_date, 500, 'pending') RETURNING id INTO v_c;
  BEGIN
    v_bid := gen_random_uuid();
    PERFORM record_payment_batch(jsonb_build_object(
      'batch', jsonb_build_object('id', v_bid, 'tenant_id', v_ta, 'trigger_invoice_id', v_c, 'amount_received', 500,
                'amount_allocated', 500, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key','r7-key','created_by','tester'),
      'invoices', jsonb_build_array(jsonb_build_object('id', v_c, 'expected_paid_amount', 0, 'paid_amount', 500, 'status','paid')),
      'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_c, 'amount', 500))));
    v_out := v_out || E'\n' || 'KNOWN-GAP  R7 (finding 35) batch for tenant A paid tenant B''s invoice and was ACCEPTED; expected rejection.';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || 'UNEXPECTED-PASS  R7 (finding 35) cross-tenant payment now rejected: '||SQLERRM||' -> gap appears fixed';
  END;

  ---------------------------------------------------------------- R8 KNOWN GAP finding 36: payment_history change not detected
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status, payment_history)
    VALUES (v_ta, v_room, current_date, current_date, current_date, current_date, 800, 'pending', '[]'::jsonb) RETURNING id INTO v_c;
  -- Caller read the invoice (paid 0, history []) ... then a concurrent writer appends history without moving paid_amount:
  UPDATE invoices SET payment_history = '[{"type":"concurrent_note","note":"added by another admin"}]'::jsonb WHERE id = v_c;
  BEGIN
    PERFORM record_payment_batch(jsonb_build_object(
      'batch', jsonb_build_object('id', gen_random_uuid(), 'tenant_id', v_ta, 'trigger_invoice_id', v_c, 'amount_received', 800,
                'amount_allocated', 800, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key','r8-key','created_by','tester'),
      'invoices', jsonb_build_array(jsonb_build_object('id', v_c, 'expected_paid_amount', 0, 'paid_amount', 800, 'status','paid',
                'payment_history','[{"type":"payment","amount":800}]'::jsonb)),
      'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_c, 'amount', 800))));
    SELECT payment_history INTO v_ph FROM invoices WHERE id = v_c;
    v_out := v_out || E'\n' || 'KNOWN-GAP  R8 (finding 36) payment accepted and concurrent payment_history entry was OVERWRITTEN; history now='||v_ph::text;
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || 'UNEXPECTED-PASS  R8 (finding 36) history change now detected: '||SQLERRM;
  END;

  ---------------------------------------------------------------- R9 input validation
  FOR v_st IN SELECT unnest(ARRAY['0|0','100|200','-5|0']) LOOP
    BEGIN
      PERFORM record_payment_batch(jsonb_build_object(
        'batch', jsonb_build_object('id', gen_random_uuid(), 'tenant_id', v_ta, 'trigger_invoice_id', v_c,
                  'amount_received', split_part(v_st,'|',1)::numeric, 'amount_allocated', split_part(v_st,'|',2)::numeric,
                  'paid_at', now(), 'idempotency_key','r9-'||v_st),
        'invoices','[]'::jsonb,'allocations','[]'::jsonb));
      v_out := v_out || E'\n' || 'FAIL  R9 received|allocated='||v_st||' accepted';
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || E'\n' || 'PASS  R9 received|allocated='||v_st||' rejected ('||SQLERRM||')';
    END;
  END LOOP;

  BEGIN
    PERFORM record_payment_batch(jsonb_build_object(
      'batch', jsonb_build_object('id', gen_random_uuid(), 'tenant_id', v_ta, 'trigger_invoice_id', v_c, 'amount_received', 10,
                'amount_allocated', 10, 'paid_at', now(), 'idempotency_key','r9-nf'),
      'invoices', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'expected_paid_amount', 0, 'paid_amount', 10, 'status','paid')),
      'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_c, 'amount', 10))));
    v_out := v_out || E'\n' || 'FAIL  R9 unknown invoice id accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'INVOICE_NOT_FOUND%' THEN 'PASS  R9 INVOICE_NOT_FOUND ('||SQLERRM||')' ELSE 'FAIL  R9 wrong error '||SQLERRM END;
  END;

  ---------------------------------------------------------------- Probes for NEW defects (observation only)
  -- P1: overpayment with NULL tenant_id: the excess is silently dropped (header says "never dropped").
  v_bid := gen_random_uuid();
  PERFORM record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', v_bid, 'trigger_invoice_id', v_c, 'amount_received', 900, 'amount_allocated', 800,
              'paid_at', now(), 'idempotency_key','p1-key'),
    'invoices','[]'::jsonb,'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_c, 'amount', 800))));
  SELECT count(*) INTO v_n FROM tenant_credits WHERE payment_batch_id = v_bid;
  v_out := v_out || E'\n' || 'PROBE  P1 overpayment (received 900, allocated 800) with NULL tenant_id -> credit rows='||v_n||
     CASE WHEN v_n=0 THEN ' (100 excess silently dropped, event still logs credit=100)' ELSE '' END;

  -- P2: negative allocation amounts that net to amount_allocated.
  BEGIN
    PERFORM record_payment_batch(jsonb_build_object(
      'batch', jsonb_build_object('id', gen_random_uuid(), 'tenant_id', v_ta, 'trigger_invoice_id', v_c, 'amount_received', 100,
                'amount_allocated', 100, 'paid_at', now(), 'idempotency_key','p2-key'),
      'invoices','[]'::jsonb,
      'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_c, 'amount', 600), jsonb_build_object('invoice_id', v_c, 'amount', -500))));
    v_out := v_out || E'\n' || 'PROBE  P2 allocations [600,-500] summing to amount_allocated=100 were ACCEPTED (negative allocation rows allowed; collides with reversal-row semantics)';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || 'PROBE  P2 negative allocation rejected: '||SQLERRM;
  END;

  -- P3: paid_amount supplied by caller is not tied to allocations or total.
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_ta, v_room, current_date, current_date, current_date, current_date, 100, 'pending') RETURNING id INTO v_a;
  v_bid := gen_random_uuid();
  PERFORM record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', v_bid, 'tenant_id', v_ta, 'trigger_invoice_id', v_a, 'amount_received', 50,
              'amount_allocated', 50, 'paid_at', now(), 'idempotency_key','p3-key'),
    'invoices', jsonb_build_array(jsonb_build_object('id', v_a, 'expected_paid_amount', 0, 'paid_amount', 99999, 'status','paid')),
    'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_a, 'amount', 50))));
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_a;
  v_out := v_out || E'\n' || 'PROBE  P3 invoice total 100, allocation 50, caller paid_amount=99999 -> stored '||v_st||' (paid_amount is not validated against allocations or total)';

  RAISE EXCEPTION 'RESULT:%', v_out;
END
$t$;
