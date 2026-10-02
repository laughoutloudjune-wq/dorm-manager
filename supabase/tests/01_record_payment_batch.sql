-- Rollback-wrapped tests for public.record_payment_batch().
-- Run ONLY on the dummy project dorm-test (rghxelkifdrpvabyxopb). Never on production.
-- Nothing persists: the block ends with RAISE EXCEPTION 'RESULT: ...' which rolls everything back.
-- Case statuses: PASS | FAIL | PROBE (observation, no verdict).
-- Former KNOWN-GAP cases (findings 35, 36, 106, 107) are now ordinary PASS/FAIL assertions.

-- Helper: call record_payment_batch and expect an error whose message starts with p_prefix.
-- Also asserts nothing was written for p_batch (the whole call rolled back).
CREATE OR REPLACE FUNCTION pg_temp.expect_rpb_err(p_label text, p_payload jsonb, p_prefix text)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_n int;
BEGIN
  BEGIN
    PERFORM public.record_payment_batch(p_payload);
  EXCEPTION WHEN OTHERS THEN
    SELECT count(*) INTO v_n FROM public.payment_batches WHERE id = NULLIF(p_payload->'batch'->>'id','')::uuid;
    IF SQLERRM LIKE p_prefix || '%' AND v_n = 0 THEN
      RETURN 'PASS  ' || p_label || ' (' || left(SQLERRM, 140) || ')';
    END IF;
    RETURN 'FAIL  ' || p_label || ' wrong error or partial write: ' || left(SQLERRM, 160) || ' batches=' || v_n;
  END;
  RETURN 'FAIL  ' || p_label || ' was ACCEPTED but should have been rejected';
END $f$;

-- Helper: one-invoice payload.
CREATE OR REPLACE FUNCTION pg_temp.pl(p_tenant uuid, p_inv uuid, p_received numeric, p_alloc numeric,
                                      p_expected numeric, p_hist int, p_new_paid numeric, p_status text, p_key text)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object(
    'batch', jsonb_build_object('id', gen_random_uuid(), 'tenant_id', p_tenant, 'trigger_invoice_id', p_inv,
              'amount_received', p_received, 'amount_allocated', p_alloc, 'paid_at', now(), 'mode','manual',
              'source','cash','idempotency_key', p_key, 'created_by','tester'),
    'invoices', jsonb_build_array(jsonb_build_object('id', p_inv, 'expected_paid_amount', p_expected,
              'expected_history_length', p_hist, 'paid_amount', p_new_paid, 'status', p_status)),
    'allocations', jsonb_build_array(jsonb_build_object('invoice_id', p_inv, 'amount', p_alloc, 'source','cash')))
$f$;

DO $t$
DECLARE
  v_out text := '';
  v_room uuid; v_ta uuid; v_tb uuid;
  v_a uuid; v_b uuid; v_c uuid; v_d uuid;
  v_bid uuid; v_res jsonb; v_n int; v_num numeric; v_msg text; v_st text;
  v_ph jsonb; v_p jsonb;
  v_due date := current_date + 30;
BEGIN
  INSERT INTO rooms(room_number) VALUES ('T-'||gen_random_uuid()) RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id) VALUES ('Test A', current_date, v_room) RETURNING id INTO v_ta;
  INSERT INTO tenants(full_name, move_in_date, room_id, status) VALUES ('Test B', current_date, v_room, 'inactive') RETURNING id INTO v_tb;

  ---------------------------------------------------------------- R1 normal multi-invoice
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_ta, v_room, current_date, v_due, current_date, current_date, 1000, 'pending') RETURNING id INTO v_a;
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_ta, v_room, current_date, v_due, current_date, current_date, 2000, 'pending') RETURNING id INTO v_b;
  v_bid := gen_random_uuid();
  v_res := record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', v_bid, 'tenant_id', v_ta, 'trigger_invoice_id', v_b, 'amount_received', 2500,
              'amount_allocated', 2500, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key','r1-key','created_by','tester'),
    'invoices', jsonb_build_array(
      jsonb_build_object('id', v_b, 'expected_paid_amount', 0, 'expected_history_length', 0, 'paid_amount', 1500, 'status','partial','payment_history','[{"x":2}]'::jsonb),
      jsonb_build_object('id', v_a, 'expected_paid_amount', 0, 'expected_history_length', 0, 'paid_amount', 1000, 'status','paid','payment_history','[{"x":1}]'::jsonb)),
    'allocations', jsonb_build_array(
      jsonb_build_object('invoice_id', v_a, 'amount', 1000, 'source','cash'),
      jsonb_build_object('invoice_id', v_b, 'amount', 1500, 'source','cash'))));
  SELECT count(*) INTO v_n FROM payment_batches WHERE id = v_bid;
  v_msg := 'batch='||v_n;
  SELECT count(*) INTO v_n FROM invoice_payment_allocations WHERE payment_batch_id = v_bid; v_msg := v_msg||' allocs='||v_n;
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_a; v_msg := v_msg||' A='||v_st;
  SELECT paid_amount::numeric(12,2)||'/'||status INTO v_st FROM invoices WHERE id = v_b; v_msg := v_msg||' B='||v_st;
  SELECT count(*) INTO v_n FROM money_events WHERE payment_batch_id = v_bid AND action='payment.record'
    AND jsonb_array_length(before->'invoices') = 2 AND jsonb_array_length(after->'invoices') = 2; v_msg := v_msg||' events='||v_n;
  SELECT count(*) INTO v_n FROM tenant_credits WHERE payment_batch_id = v_bid; v_msg := v_msg||' credits='||v_n;
  SELECT payment_history::text INTO v_st FROM invoices WHERE id = v_a; v_msg := v_msg||' A.hist='||v_st;
  v_out := v_out || E'\n' || CASE WHEN (v_res->>'replayed')='false' AND v_msg = 'batch=1 allocs=2 A=1000.00/paid B=1500.00/partial events=1 credits=0 A.hist=[{"x": 1}]'
    THEN 'PASS  R1 normal multi-invoice payment, invoices given out of id order ('||v_msg||')' ELSE 'FAIL  R1 normal multi-invoice payment ('||v_msg||' res='||v_res::text||')' END;

  ---------------------------------------------------------------- R2 idempotent replay
  v_res := record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', gen_random_uuid(), 'tenant_id', v_ta, 'trigger_invoice_id', v_b, 'amount_received', 2500,
              'amount_allocated', 2500, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key','r1-key','created_by','tester'),
    'invoices', jsonb_build_array(jsonb_build_object('id', v_a, 'expected_paid_amount', 0, 'expected_history_length', 0, 'paid_amount', 2500, 'status','paid')),
    'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_a, 'amount', 2500))));
  SELECT count(*) INTO v_n FROM payment_batches WHERE trigger_invoice_id = v_b AND idempotency_key='r1-key';
  v_msg := 'replayed='||(v_res->>'replayed')||' same_id='||((v_res->>'payment_batch_id')::uuid = v_bid)||' voided='||(v_res->>'voided')||' batches='||v_n;
  SELECT count(*) INTO v_n FROM invoice_payment_allocations WHERE payment_batch_id = v_bid; v_msg := v_msg||' allocs='||v_n;
  SELECT paid_amount INTO v_num FROM invoices WHERE id = v_a; v_msg := v_msg||' A.paid='||v_num::numeric(12,2);
  v_out := v_out || E'\n' || CASE WHEN v_msg = 'replayed=true same_id=true voided=false batches=1 allocs=2 A.paid=1000.00'
    THEN 'PASS  R2 idempotent replay same key, checked after locks, even with a now-stale payload ('||v_msg||')' ELSE 'FAIL  R2 idempotent replay same key ('||v_msg||')' END;

  ---------------------------------------------------------------- R3 race simulation (unique-violation path)
  -- A true two-session race cannot run inside one transaction. Force the INSERT to hit a unique violation
  -- while the idempotency check misses: reuse an existing batch PRIMARY KEY with a NEW key. The handler must re-raise.
  BEGIN
    PERFORM record_payment_batch(jsonb_build_object(
      'batch', jsonb_build_object('id', v_bid, 'tenant_id', v_ta, 'trigger_invoice_id', v_b, 'amount_received', 10,
                'amount_allocated', 0, 'paid_at', now(), 'mode','manual','source','cash','idempotency_key','r3-other-key','created_by','tester'),
      'invoices','[]'::jsonb,'allocations','[]'::jsonb));
    v_out := v_out || E'\n' || 'FAIL  R3 unique-violation path: no error raised (duplicate batch id accepted)';
  EXCEPTION WHEN unique_violation THEN
    v_out := v_out || E'\n' || 'PASS  R3 unique-violation path re-raises when no idempotent winner exists (SQLSTATE 23505). Same-key two-session race needs two connections (see README).';
  WHEN OTHERS THEN
    v_out := v_out || E'\n' || 'FAIL  R3 unexpected error: '||SQLERRM;
  END;

  ---------------------------------------------------------------- R4 STALE_INVOICE on changed paid_amount
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, paid_amount, status)
    VALUES (v_ta, v_room, current_date, v_due, current_date, current_date, 1000, 300, 'partial') RETURNING id INTO v_c;
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R4 STALE_INVOICE on changed paid_amount',
    pg_temp.pl(v_ta, v_c, 700, 700, 0, 0, 700, 'partial', 'r4-key'), 'STALE_INVOICE');
  SELECT paid_amount INTO v_num FROM invoices WHERE id = v_c;
  v_out := v_out || E'\n' || CASE WHEN v_num = 300 THEN 'PASS  R4b invoice untouched after STALE_INVOICE' ELSE 'FAIL  R4b paid='||v_num END;

  ---------------------------------------------------------------- R5 allocation sum != amount_allocated
  v_p := pg_temp.pl(v_ta, v_c, 700, 600, 300, 0, 900, 'partial', 'r5-key');
  v_p := jsonb_set(v_p, '{batch,amount_allocated}', '700');
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R5 allocation sum mismatch rejected', v_p, 'allocations (600) do not equal amount_allocated (700)');

  ---------------------------------------------------------------- R6 overpayment -> exactly one credit row
  v_p := pg_temp.pl(v_ta, v_c, 1000, 700, 300, 0, 1000, 'paid', 'r6-key');
  v_bid := (v_p->'batch'->>'id')::uuid;
  PERFORM record_payment_batch(v_p);
  SELECT count(*), COALESCE(sum(amount),0) INTO v_n, v_num FROM tenant_credits WHERE payment_batch_id = v_bid AND kind='overpayment' AND bucket='unapplied' AND tenant_id = v_ta;
  SELECT count(*)::text INTO v_msg FROM tenant_credits WHERE payment_batch_id = v_bid;
  v_out := v_out || E'\n' || CASE WHEN v_n=1 AND v_num=300 AND v_msg::int=1 THEN 'PASS  R6 overpayment creates exactly one overpayment credit (300)'
    ELSE 'FAIL  R6 overpayment credits='||v_n||' sum='||v_num||' total_rows='||v_msg END;
  v_p := jsonb_set(v_p, '{batch,id}', to_jsonb(gen_random_uuid()));
  v_res := record_payment_batch(v_p);   -- identical retry, same key
  SELECT count(*) INTO v_n FROM tenant_credits WHERE payment_batch_id = v_bid;
  v_out := v_out || E'\n' || CASE WHEN v_n=1 AND (v_res->>'replayed')='true' AND (v_res->>'payment_batch_id')::uuid = v_bid
    THEN 'PASS  R6b replay of overpaid receipt adds no second credit' ELSE 'FAIL  R6b credits after replay='||v_n||' res='||v_res::text END;

  ---------------------------------------------------------------- R7 finding 35: invoice of another tenant
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_tb, v_room, current_date, v_due, current_date, current_date, 500, 'pending') RETURNING id INTO v_c;
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R7 (finding 35) batch for tenant A paying tenant B''s invoice rejected',
    pg_temp.pl(v_ta, v_c, 500, 500, 0, 0, 500, 'paid', 'r7-key'), 'TENANT_MISMATCH');
  -- R7b: trigger belongs to tenant A but invoices[] includes tenant B's invoice
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status)
    VALUES (v_ta, v_room, current_date, v_due, current_date, current_date, 500, 'pending') RETURNING id INTO v_d;
  v_p := jsonb_build_object(
    'batch', jsonb_build_object('id', gen_random_uuid(), 'tenant_id', v_ta, 'trigger_invoice_id', v_d, 'amount_received', 1000,
              'amount_allocated', 1000, 'paid_at', now(), 'idempotency_key','r7b'),
    'invoices', jsonb_build_array(
      jsonb_build_object('id', v_d, 'expected_paid_amount', 0, 'expected_history_length', 0, 'paid_amount', 500, 'status','paid'),
      jsonb_build_object('id', v_c, 'expected_paid_amount', 0, 'expected_history_length', 0, 'paid_amount', 500, 'status','paid')),
    'allocations', jsonb_build_array(jsonb_build_object('invoice_id', v_d, 'amount', 500), jsonb_build_object('invoice_id', v_c, 'amount', 500)));
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R7b chain containing another tenant''s invoice rejected', v_p, 'TENANT_MISMATCH');
  -- R7c: no tenant_id on batch, invoice owned by someone other than the trigger's tenant
  v_p := jsonb_set(v_p, '{batch,tenant_id}', 'null');
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R7c NULL batch tenant: invoices must share the trigger invoice''s tenant', v_p, 'TENANT_MISMATCH');
  -- R7d: NULL batch tenant, all invoices of the trigger's tenant, no excess -> accepted
  v_p := pg_temp.pl(NULL, v_d, 200, 200, 0, 0, 200, 'partial', 'r7d');
  v_res := record_payment_batch(v_p);
  v_out := v_out || E'\n' || CASE WHEN (v_res->>'replayed')='false' THEN 'PASS  R7d NULL batch tenant with same-tenant invoices and no excess accepted'
    ELSE 'FAIL  R7d '||v_res::text END;

  ---------------------------------------------------------------- R8 finding 36: payment_history guard
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, status, payment_history)
    VALUES (v_ta, v_room, current_date, v_due, current_date, current_date, 800, 'pending', '[]'::jsonb) RETURNING id INTO v_c;
  -- Caller read (paid 0, history length 0) ... then a concurrent writer appends history without moving paid_amount:
  UPDATE invoices SET payment_history = '[{"type":"concurrent_note","note":"added by another admin"}]'::jsonb WHERE id = v_c;
  v_p := pg_temp.pl(v_ta, v_c, 800, 800, 0, 0, 800, 'paid', 'r8-key');
  v_p := jsonb_set(v_p, '{invoices,0,payment_history}', '[{"type":"payment","amount":800}]');
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R8 (finding 36) concurrent payment_history change detected', v_p, 'STALE_INVOICE');
  SELECT payment_history INTO v_ph FROM invoices WHERE id = v_c;
  v_out := v_out || E'\n' || CASE WHEN v_ph = '[{"type":"concurrent_note","note":"added by another admin"}]'::jsonb
    THEN 'PASS  R8b concurrent history entry preserved' ELSE 'FAIL  R8b history='||v_ph::text END;
  -- R8c: right length but the caller's copy of the old entry differs: stored entry kept, only the new tail appended
  v_p := pg_temp.pl(v_ta, v_c, 800, 800, 0, 1, 800, 'paid', 'r8c-key');
  v_p := jsonb_set(v_p, '{invoices,0,payment_history}', '[{"type":"FORGED"},{"type":"payment","amount":800}]');
  PERFORM record_payment_batch(v_p);
  SELECT payment_history INTO v_ph FROM invoices WHERE id = v_c;
  v_out := v_out || E'\n' || CASE WHEN v_ph = '[{"type":"concurrent_note","note":"added by another admin"},{"type":"payment","amount":800}]'::jsonb
    THEN 'PASS  R8c existing history entries never overwritten (only the new tail is appended)' ELSE 'FAIL  R8c history='||v_ph::text END;
  -- R8d: missing expected_history_length
  v_p := pg_temp.pl(v_ta, v_d, 10, 10, 200, 0, 210, 'partial', 'r8d');
  v_p := v_p #- '{invoices,0,expected_history_length}';
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R8d missing expected_history_length rejected', v_p, 'INVALID_PAYLOAD');
  -- R8e: more money onto an invoice that is already fully paid
  v_p := pg_temp.pl(v_ta, v_c, 1, 1, 800, 2, 801, 'paid', 'r8e');
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R8e payment onto a fully paid invoice rejected', v_p, 'OVERPAID_INVOICE');

  ---------------------------------------------------------------- R9 input validation
  FOR v_st IN SELECT unnest(ARRAY['0|0','100|200','-5|0']) LOOP
    v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R9 received|allocated='||v_st||' rejected',
      jsonb_build_object('batch', jsonb_build_object('id', gen_random_uuid(), 'tenant_id', v_ta, 'trigger_invoice_id', v_d,
                  'amount_received', split_part(v_st,'|',1)::numeric, 'amount_allocated', split_part(v_st,'|',2)::numeric,
                  'paid_at', now(), 'idempotency_key','r9-'||v_st), 'invoices','[]'::jsonb,'allocations','[]'::jsonb), 'amount_');
  END LOOP;
  v_n := 0;
  v_p := pg_temp.pl(v_ta, gen_random_uuid(), 10, 10, 0, 0, 10, 'partial', 'r9-nf');
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R9 unknown invoice id', v_p, 'INVOICE_NOT_FOUND');

  ---------------------------------------------------------------- R10 finding 106: excess with NULL tenant_id
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R10 (finding 106) excess with NULL tenant_id rejected',
    pg_temp.pl(NULL, v_d, 900, 100, 200, 0, 300, 'partial', 'r10'), 'TENANT_REQUIRED');

  ---------------------------------------------------------------- R11-R20 finding 107: payload validation
  v_p := pg_temp.pl(v_ta, v_d, 100, 100, 200, 0, 300, 'partial', 'r11');
  v_p := jsonb_set(v_p, '{allocations}', jsonb_build_array(jsonb_build_object('invoice_id', v_d, 'amount', 600), jsonb_build_object('invoice_id', v_d, 'amount', -500)));
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R11 negative allocation [600,-500] rejected', v_p, 'INVALID_PAYLOAD');

  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R12 paid_amount not equal to old + allocation (99999) rejected',
    pg_temp.pl(v_ta, v_d, 50, 50, 200, 0, 99999, 'paid', 'r12'), 'INVALID_PAYLOAD');

  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R13 paid_amount above total_amount rejected',
    pg_temp.pl(v_ta, v_d, 400, 400, 200, 0, 600, 'paid', 'r13'), 'OVERPAID_INVOICE');

  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R14 status cancelled (not a payment status) rejected',
    pg_temp.pl(v_ta, v_d, 50, 50, 200, 0, 250, 'cancelled', 'r14'), 'INVALID_PAYLOAD');
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R14b unknown status rejected',
    pg_temp.pl(v_ta, v_d, 50, 50, 200, 0, 250, 'bogus', 'r14b'), 'INVALID_PAYLOAD');
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R14c status paid while balance still owed rejected',
    pg_temp.pl(v_ta, v_d, 50, 50, 200, 0, 250, 'paid', 'r14c'), 'INVALID_PAYLOAD');

  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R15 3-decimal amounts rejected',
    pg_temp.pl(v_ta, v_d, 50.005, 50.005, 200, 0, 250.005, 'partial', 'r15'), 'INVALID_PAYLOAD');

  v_p := pg_temp.pl(v_ta, v_d, 50, 50, 200, 0, 250, 'partial', 'r16');
  v_p := jsonb_set(v_p, '{allocations,0,invoice_id}', to_jsonb(v_a));
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R16 allocation to an invoice missing from invoices[] rejected', v_p, 'INVALID_PAYLOAD');

  v_p := pg_temp.pl(v_ta, v_d, 50, 50, 200, 0, 250, 'partial', 'r17');
  v_p := jsonb_set(v_p, '{invoices}', (v_p->'invoices') || jsonb_build_array(jsonb_build_object('id', v_b, 'expected_paid_amount', 1500,
            'expected_history_length', 1, 'paid_amount', 1500, 'status','paid')));
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R17 invoices[] entry without allocation (status-only rewrite) rejected', v_p, 'INVALID_PAYLOAD');

  v_p := pg_temp.pl(v_ta, v_d, 50, 50, 200, 0, 250, 'partial', 'r18');
  v_p := v_p #- '{invoices,0,expected_paid_amount}';
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R18 missing expected_paid_amount rejected', v_p, 'INVALID_PAYLOAD');

  v_p := pg_temp.pl(v_ta, v_d, 50, 50, 200, 0, 250, 'partial', 'r19');
  v_p := jsonb_set(v_p, '{invoices}', (v_p->'invoices') || (v_p->'invoices'));
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R19 duplicate invoice in invoices[] rejected', v_p, 'INVALID_PAYLOAD');

  UPDATE invoices SET status = 'cancelled' WHERE id = v_b;
  v_out := v_out || E'\n' || pg_temp.expect_rpb_err('R20 payment to a cancelled invoice rejected',
    pg_temp.pl(v_ta, v_b, 100, 100, 1500, 1, 1600, 'partial', 'r20'), 'INVOICE_NOT_PAYABLE');

  ---------------------------------------------------------------- R21 money_events completeness
  SELECT count(*) INTO v_n FROM money_events m JOIN payment_batches b ON b.id = m.payment_batch_id
   WHERE b.tenant_id = v_ta AND m.action = 'payment.record'
     AND (m.after ? 'allocations') AND (m.after ? 'invoices') AND (m.before ? 'invoices');
  SELECT count(*) INTO v_num FROM payment_batches WHERE tenant_id = v_ta;
  v_out := v_out || E'\n' || CASE WHEN v_n = v_num AND v_n > 0 THEN 'PASS  R21 every recorded batch has one payment.record event with before/after invoices and allocations ('||v_n||')'
    ELSE 'FAIL  R21 events='||v_n||' batches='||v_num END;

  ---------------------------------------------------------------- R22 grants
  SELECT string_agg(r, ',') INTO v_st FROM unnest(ARRAY['anon','authenticated']) r
   WHERE has_function_privilege(r, 'public.record_payment_batch(jsonb)', 'EXECUTE');
  v_out := v_out || E'\n' || CASE WHEN v_st IS NULL AND has_function_privilege('service_role', 'public.record_payment_batch(jsonb)', 'EXECUTE')
    THEN 'PASS  R22 only service_role can execute record_payment_batch' ELSE 'FAIL  R22 executable by '||COALESCE(v_st,'?') END;

  RAISE EXCEPTION 'RESULT:%', v_out;
END
$t$;
