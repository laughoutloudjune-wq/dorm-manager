-- Rollback-wrapped tests for the late-fee approval flow (migration 20261002000800):
-- post_late_fee_charge, waive_late_fee, reverse_late_fee_waiver, create_late_fee_policy.
-- Run ONLY on the dummy project dorm-test (rghxelkifdrpvabyxopb). Never on production.
-- Nothing persists: the DO block ends with RAISE EXCEPTION 'RESULT: ...', which rolls back every fixture row.

-- Columns a caller would send: the CURRENT stored columns of an invoice moved by `delta`
-- on total / late_fee_amount / additional_fees_total (what toInvoiceMoneyColumns gives
-- after adding or removing a late-fee line).
CREATE OR REPLACE FUNCTION pg_temp.cols(p_inv uuid, p_delta numeric)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object(
    'expected_total_amount', COALESCE(total_amount, 0),
    'columns', jsonb_build_object(
      'total_amount', COALESCE(total_amount, 0) + p_delta,
      'late_fee_amount', COALESCE(late_fee_amount, 0) + p_delta,
      'additional_fees_total', COALESCE(additional_fees_total, 0) + p_delta,
      'carry_forward_amount', COALESCE(carry_forward_amount, 0),
      'discount_amount', COALESCE(discount_amount, 0)))
  FROM invoices WHERE id = p_inv
$f$;

CREATE OR REPLACE FUNCTION pg_temp.charge(p_src uuid, p_tgt uuid, p_from date, p_to date, p_amount numeric,
                                          p_version int, p_by text, p_rate numeric DEFAULT 50)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('source_invoice_id', p_src, 'target_invoice_id', p_tgt,
    'covered_from', p_from, 'covered_to', p_to, 'eligible_balance', 3000,
    'rate_kind', 'flat_per_day', 'rate_value', p_rate,
    'formula', (p_to - p_from + 1) || ' days x ' || p_rate || ' baht/day = ' || p_amount,
    'policy_version', p_version, 'amount', p_amount, 'posted_by', p_by)
$f$;

-- Engine identity on a stored row (the SQL mirror of computeInvoiceTotal(chargesFromInvoiceRow(row))).
CREATE OR REPLACE FUNCTION pg_temp.engine_ok(p_inv uuid)
RETURNS boolean LANGUAGE sql AS $f$
  SELECT i.total_amount = COALESCE(i.rent_amount,0) + COALESCE(i.water_bill,0) + COALESCE(i.electricity_bill,0)
       + COALESCE(i.common_fee,0) + COALESCE(i.late_fee_amount,0) + COALESCE(i.additional_fees_total,0)
       - (SELECT COALESCE(sum((e->>'total_amount')::numeric),0) FROM jsonb_array_elements(COALESCE(i.additional_fees_breakdown,'[]')) e
           WHERE e->>'item_type' = 'late_fee_line')
       + COALESCE(i.carry_forward_amount,0) - COALESCE(i.discount_amount,0)
  FROM invoices i WHERE i.id = p_inv
$f$;

DO $t$
DECLARE
  v_out text := '';
  v_room uuid; v_room2 uuid; v_ta uuid; v_tb uuid;
  v_src uuid; v_tgt uuid; v_other uuid; v_bad uuid; v_paid uuid; v_future_src uuid; v_future_tgt uuid;
  v_ver int; v_ver2 int; v_auto_ver int;
  v_res jsonb; v_res2 jsonb; v_charge uuid; v_adj uuid; v_rev uuid;
  v_n int; v_num numeric; v_msg text; v_st text; v_blank text;
  v_cnt_before int;
BEGIN
  INSERT INTO rooms(room_number) VALUES ('T-'||gen_random_uuid()) RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id) VALUES ('LateFee Test A', current_date, v_room) RETURNING id INTO v_ta;
  INSERT INTO rooms(room_number) VALUES ('T-'||gen_random_uuid()) RETURNING id INTO v_room2;
  INSERT INTO tenants(full_name, move_in_date, room_id) VALUES ('LateFee Test B', current_date, v_room2) RETURNING id INTO v_tb;

  -- Source: September, due 2026-09-05, still unpaid. Target: October, open.
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, total_amount, paid_amount, status)
    VALUES (v_ta, v_room, '2026-08-25', '2026-09-05', '2026-09-01', '2026-09-30', 3000, 3000, 0, 'overdue') RETURNING id INTO v_src;
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, total_amount, paid_amount,
                       late_fee_amount, additional_fees_total, additional_fees_breakdown, status)
    VALUES (v_ta, v_room, '2026-09-25', '2026-10-05', '2026-10-01', '2026-10-31', 3000, 3200, 0, 0, 200,
            '[{"label":"cleaning","total_amount":200,"amount":200}]', 'pending') RETURNING id INTO v_tgt;

  ---------------------------------------------------------------- P1 policy creation (versioned, auto_post default false)
  v_res := create_late_fee_policy(jsonb_build_object('effective_from','2026-01-01','grace_days',0,'rate_kind','flat_per_day',
            'rate_value',50,'cap',1000,'rounding','floor','created_by','tester','note','test policy'));
  v_ver := (v_res->>'version')::int;
  SELECT count(*) INTO v_n FROM late_fee_policies WHERE version = v_ver AND auto_post = false AND created_by = 'tester';
  SELECT count(*) INTO v_cnt_before FROM money_events WHERE action = 'late_fee.policy_created' AND actor_user_id = 'tester';
  v_res2 := create_late_fee_policy(jsonb_build_object('effective_from','2027-01-01','rate_kind','flat_per_day','rate_value',80,'created_by','tester'));
  v_ver2 := (v_res2->>'version')::int;
  SELECT count(*) INTO v_num FROM late_fee_policies WHERE version = v_ver AND rate_value = 50;
  v_out := v_out || E'\n' || CASE WHEN v_n = 1 AND v_ver2 = v_ver + 1 AND v_num = 1 AND v_cnt_before >= 1
    THEN 'PASS  P1 policies are new versions (v'||v_ver||', v'||v_ver2||'), auto_post defaults false, old version unchanged, event logged'
    ELSE 'FAIL  P1 n='||v_n||' v='||v_ver||'/'||v_ver2||' old='||v_num END;
  BEGIN
    UPDATE late_fee_policies SET rate_value = 999 WHERE version = v_ver;
    v_out := v_out || E'\n' || 'FAIL  P2 policy row was edited in place';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || 'PASS  P2 editing an existing policy rejected ('||SQLERRM||')';
  END;

  ---------------------------------------------------------------- L1 post
  v_res := post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_tgt, '2026-09-06', '2026-09-08', 150, v_ver, 'admin-1'),
                                                    'target', pg_temp.cols(v_tgt, 150)));
  v_charge := (v_res->>'charge_id')::uuid;
  SELECT total_amount::numeric(12,2)||'/'||late_fee_amount::numeric(12,2)||'/'||additional_fees_total::numeric(12,2) INTO v_st FROM invoices WHERE id = v_tgt;
  SELECT count(*) INTO v_n FROM invoices i, jsonb_array_elements(i.additional_fees_breakdown) e
   WHERE i.id = v_tgt AND e->>'item_type' = 'late_fee_line' AND e->>'late_fee_charge_id' = v_charge::text
     AND e->>'source_invoice_id' = v_src::text AND (e->>'total_amount')::numeric = 150;
  v_msg := 'cols='||v_st||' line='||v_n;
  SELECT count(*) INTO v_n FROM late_fee_charges WHERE id = v_charge AND posted_by = 'admin-1' AND target_invoice_id = v_tgt;
  v_msg := v_msg||' charge='||v_n;
  SELECT count(*) INTO v_n FROM money_events WHERE action = 'late_fee.post' AND invoice_id = v_tgt AND actor_user_id = 'admin-1';
  v_msg := v_msg||' event='||v_n||' engine='||pg_temp.engine_ok(v_tgt);
  v_out := v_out || E'\n' || CASE WHEN v_msg = 'cols=3350.00/150.00/350.00 line=1 charge=1 event=1 engine=true' AND (v_res->>'replayed')::boolean = false
    THEN 'PASS  L1 post: distinct linked late_fee_line, columns +150, charge row, audit event ('||v_msg||')'
    ELSE 'FAIL  L1 '||v_msg||' res='||v_res::text END;
  SELECT count(*) INTO v_n FROM invoices WHERE id = v_src AND late_fee_billed_at IS NOT NULL;
  v_out := v_out || E'\n' || CASE WHEN v_n = 1 THEN 'PASS  L1b (finding 143) posting sets late_fee_billed_at on the SOURCE invoice'
    ELSE 'FAIL  L1b source late_fee_billed_at not set' END;

  ---------------------------------------------------------------- L2 duplicate replays (stale screen values are irrelevant to a replay)
  v_res2 := post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_tgt, '2026-09-06', '2026-09-08', 150, v_ver, 'admin-1'),
                                                     'target', jsonb_build_object('expected_total_amount', 3200, 'columns', (pg_temp.cols(v_tgt, 0))->'columns')));
  SELECT count(*) INTO v_n FROM late_fee_charges WHERE source_invoice_id = v_src;
  SELECT total_amount INTO v_num FROM invoices WHERE id = v_tgt;
  v_out := v_out || E'\n' || CASE WHEN (v_res2->>'replayed')::boolean AND (v_res2->>'charge_id')::uuid = v_charge AND v_n = 1 AND v_num = 3350
    THEN 'PASS  L2 duplicate post replayed the original (charges=1, total still 3350)'
    ELSE 'FAIL  L2 res='||v_res2::text||' charges='||v_n||' total='||v_num END;
  BEGIN
    PERFORM post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_tgt, '2026-09-06', '2026-09-08', 100, v_ver, 'admin-1'),
                                                     'target', pg_temp.cols(v_tgt, 100)));
    v_out := v_out || E'\n' || 'FAIL  L2b same key, different amount accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'DUPLICATE_CHARGE_DIFFERENT%' THEN 'PASS  L2b same key with a different amount rejected (DUPLICATE_CHARGE_DIFFERENT)' ELSE 'FAIL  L2b '||SQLERRM END;
  END;

  ---------------------------------------------------------------- L3 overlapping days
  BEGIN
    PERFORM post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_tgt, '2026-09-08', '2026-09-10', 150, v_ver, 'admin-1'),
                                                     'target', pg_temp.cols(v_tgt, 150)));
    v_out := v_out || E'\n' || 'FAIL  L3 overlapping period accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'OVERLAPPING_CHARGE%' THEN 'PASS  L3 overlapping period rejected (OVERLAPPING_CHARGE)' ELSE 'FAIL  L3 '||SQLERRM END;
  END;

  ---------------------------------------------------------------- L4 stale target total
  BEGIN
    PERFORM post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_tgt, '2026-09-09', '2026-09-10', 100, v_ver, 'admin-1'),
               'target', jsonb_build_object('expected_total_amount', 3200,
                  'columns', jsonb_build_object('total_amount', 3300, 'late_fee_amount', 100, 'additional_fees_total', 300,
                                                'carry_forward_amount', 0, 'discount_amount', 0))));
    v_out := v_out || E'\n' || 'FAIL  L4 stale total accepted';
  EXCEPTION WHEN OTHERS THEN
    SELECT count(*) INTO v_n FROM late_fee_charges WHERE source_invoice_id = v_src;
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'STALE_INVOICE%' AND v_n = 1 THEN 'PASS  L4 stale target total rejected, nothing written ('||split_part(SQLERRM,' ',1)||')' ELSE 'FAIL  L4 '||SQLERRM||' charges='||v_n END;
  END;

  ---------------------------------------------------------------- L5 columns that are not "current + fee"
  BEGIN
    v_res := pg_temp.cols(v_tgt, 100);
    v_res := jsonb_set(v_res, '{columns,late_fee_amount}', to_jsonb(150)); -- fee folded into general fees instead
    PERFORM post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_tgt, '2026-09-09', '2026-09-10', 100, v_ver, 'admin-1'), 'target', v_res));
    v_out := v_out || E'\n' || 'FAIL  L5 inconsistent columns accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'INCONSISTENT_COLUMNS%' THEN 'PASS  L5 columns not equal to current+fee rejected (INCONSISTENT_COLUMNS)' ELSE 'FAIL  L5 '||SQLERRM END;
  END;

  ---------------------------------------------------------------- L6 amount above the policy rate / L7 cap
  BEGIN
    PERFORM post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_tgt, '2026-09-09', '2026-09-10', 500, v_ver, 'admin-1'),
                                                     'target', pg_temp.cols(v_tgt, 500)));
    v_out := v_out || E'\n' || 'FAIL  L6 amount above rate accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'AMOUNT_EXCEEDS_RATE%' THEN 'PASS  L6 2 days x 50 cannot post 500 (AMOUNT_EXCEEDS_RATE)' ELSE 'FAIL  L6 '||SQLERRM END;
  END;
  BEGIN
    PERFORM post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_tgt, '2026-09-09', '2026-10-31', 1000, v_ver, 'admin-1'),
                                                     'target', pg_temp.cols(v_tgt, 1000)));
    v_out := v_out || E'\n' || 'FAIL  L7 cap exceeded accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'CAP_EXCEEDED%' THEN 'PASS  L7 150 posted + 1000 over the 1000 cap rejected (CAP_EXCEEDED)' ELSE 'FAIL  L7 '||SQLERRM END;
  END;

  ---------------------------------------------------------------- L8 automation needs auto_post / L9 cross-tenant / L10 rate mismatch
  BEGIN
    PERFORM post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_tgt, '2026-09-09', '2026-09-10', 100, v_ver, 'automation:test'),
                                                     'target', pg_temp.cols(v_tgt, 100)));
    v_out := v_out || E'\n' || 'FAIL  L8 automation posted under a policy without auto_post';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'AUTO_POST_DISABLED%' THEN 'PASS  L8 automation refused when policy auto_post=false (AUTO_POST_DISABLED)' ELSE 'FAIL  L8 '||SQLERRM END;
  END;
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, total_amount, status)
    VALUES (v_tb, v_room2, '2026-09-25', '2026-10-05', '2026-10-01', '2026-10-31', 3000, 3000, 'pending') RETURNING id INTO v_other;
  BEGIN
    PERFORM post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_other, '2026-09-09', '2026-09-10', 100, v_ver, 'admin-1'),
                                                     'target', pg_temp.cols(v_other, 100)));
    v_out := v_out || E'\n' || 'FAIL  L9 fee posted onto another tenant''s invoice';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'TENANT_MISMATCH%' THEN 'PASS  L9 cross-tenant target rejected (TENANT_MISMATCH)' ELSE 'FAIL  L9 '||SQLERRM END;
  END;
  BEGIN
    PERFORM post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_tgt, '2026-09-09', '2026-09-10', 100, v_ver, 'admin-1', 75),
                                                     'target', pg_temp.cols(v_tgt, 100)));
    v_out := v_out || E'\n' || 'FAIL  L10 rate different from the policy accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'RATE_MISMATCH%' THEN 'PASS  L10 charge rate must match its policy version (RATE_MISMATCH)' ELSE 'FAIL  L10 '||SQLERRM END;
  END;

  ---------------------------------------------------------------- L11 target not open (paid) / L12 engine mismatch
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, total_amount, paid_amount, status)
    VALUES (v_ta, v_room, '2026-10-25', '2026-11-05', '2026-11-01', '2026-11-30', 3000, 3000, 3000, 'paid') RETURNING id INTO v_paid;
  BEGIN
    PERFORM post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_paid, '2026-09-09', '2026-09-10', 100, v_ver, 'admin-1'),
                                                     'target', pg_temp.cols(v_paid, 100)));
    v_out := v_out || E'\n' || 'FAIL  L11 fee posted onto a paid invoice';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'TARGET_NOT_OPEN%' THEN 'PASS  L11 paid target rejected (TARGET_NOT_OPEN)' ELSE 'FAIL  L11 '||SQLERRM END;
  END;
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, total_amount, status)
    VALUES (v_ta, v_room, '2026-11-25', '2026-12-05', '2026-12-01', '2026-12-31', 3000, 9999, 'pending') RETURNING id INTO v_bad;
  BEGIN
    PERFORM post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_bad, '2026-09-09', '2026-09-10', 100, v_ver, 'admin-1'),
                                                     'target', pg_temp.cols(v_bad, 100)));
    v_out := v_out || E'\n' || 'FAIL  L12 posted onto an invoice whose stored total disagrees with the engine';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'ENGINE_MISMATCH%' THEN 'PASS  L12 target whose total disagrees with the totals engine rejected (ENGINE_MISMATCH)' ELSE 'FAIL  L12 '||SQLERRM END;
  END;

  ---------------------------------------------------------------- W1 waiver needs a reason and an approver
  FOREACH v_blank IN ARRAY ARRAY['', '   ', E'\t\n'] LOOP
    BEGIN
      PERFORM waive_late_fee(jsonb_build_object('waiver', jsonb_build_object('charge_id', v_charge, 'amount', 50, 'reason', v_blank,
                 'approver', 'owner', 'idempotency_key', 'w-blank'), 'target', pg_temp.cols(v_tgt, -50)));
      v_out := v_out || E'\n' || 'FAIL  W1 blank reason accepted ['||replace(replace(v_blank,E'\t','\t'),E'\n','\n')||']';
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'REASON_REQUIRED%' THEN 'PASS  W1 blank reason ['||replace(replace(v_blank,E'\t','\t'),E'\n','\n')||'] rejected (REASON_REQUIRED)' ELSE 'FAIL  W1 '||SQLERRM END;
    END;
  END LOOP;
  BEGIN
    PERFORM waive_late_fee(jsonb_build_object('waiver', jsonb_build_object('charge_id', v_charge, 'amount', 50, 'reason', 'tenant was in hospital',
               'approver', ' ', 'idempotency_key', 'w-noapp'), 'target', pg_temp.cols(v_tgt, -50)));
    v_out := v_out || E'\n' || 'FAIL  W1b blank approver accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'APPROVER_REQUIRED%' THEN 'PASS  W1b blank approver rejected (APPROVER_REQUIRED)' ELSE 'FAIL  W1b '||SQLERRM END;
  END;

  ---------------------------------------------------------------- W2 over-waiver (no sentinel amounts)
  FOREACH v_num IN ARRAY ARRAY[151, 99999999]::numeric[] LOOP
    BEGIN
      PERFORM waive_late_fee(jsonb_build_object('waiver', jsonb_build_object('charge_id', v_charge, 'amount', v_num, 'reason', 'goodwill',
                 'approver', 'owner', 'idempotency_key', 'w-over-'||v_num), 'target', pg_temp.cols(v_tgt, -v_num)));
      v_out := v_out || E'\n' || 'FAIL  W2 over-waiver of '||v_num||' accepted';
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'WAIVER_EXCEEDS_FEE%' THEN 'PASS  W2 waiver of '||v_num||' on a 150 fee rejected (WAIVER_EXCEEDS_FEE)' ELSE 'FAIL  W2 '||SQLERRM END;
    END;
  END LOOP;

  ---------------------------------------------------------------- W3 partial waiver / W4 replay / W5 second waiver capped by the remainder
  v_res := waive_late_fee(jsonb_build_object('waiver', jsonb_build_object('charge_id', v_charge, 'amount', 100, 'reason', 'first-time late, goodwill',
             'approver', 'owner', 'idempotency_key', 'w-1'), 'target', pg_temp.cols(v_tgt, -100)));
  v_adj := (v_res->>'adjustment_id')::uuid;
  SELECT total_amount::numeric(12,2)||'/'||late_fee_amount::numeric(12,2)||'/'||additional_fees_total::numeric(12,2) INTO v_st FROM invoices WHERE id = v_tgt;
  SELECT (e->>'original_amount')||'/'||(e->>'waived_amount')||'/'||(e->>'total_amount') INTO v_msg
    FROM invoices i, jsonb_array_elements(i.additional_fees_breakdown) e WHERE i.id = v_tgt AND e->>'late_fee_charge_id' = v_charge::text;
  SELECT count(*) INTO v_n FROM adjustments WHERE id = v_adj AND type = 'waiver' AND amount = 100 AND actor = 'owner'
     AND reason = 'first-time late, goodwill' AND source = 'late_fee_charge:'||v_charge;
  v_out := v_out || E'\n' || CASE WHEN v_st = '3250.00/50.00/250.00' AND v_msg = '150.00/100/50.00' AND v_n = 1 AND pg_temp.engine_ok(v_tgt)
    THEN 'PASS  W3 waiver 100 of 150: adjustments row (reason+approver), line 150/100/50, columns -100, engine ok'
    ELSE 'FAIL  W3 cols='||v_st||' line='||v_msg||' adj='||v_n END;
  v_res2 := waive_late_fee(jsonb_build_object('waiver', jsonb_build_object('charge_id', v_charge, 'amount', 100, 'reason', 'first-time late, goodwill',
             'approver', 'owner', 'idempotency_key', 'w-1'), 'target', jsonb_build_object('expected_total_amount', 3350, 'columns', '{}'::jsonb)));
  SELECT count(*) INTO v_n FROM adjustments WHERE source = 'late_fee_charge:'||v_charge;
  v_out := v_out || E'\n' || CASE WHEN (v_res2->>'replayed')::boolean AND (v_res2->>'adjustment_id')::uuid = v_adj AND v_n = 1
    THEN 'PASS  W4 retried waiver replayed (1 adjustment)' ELSE 'FAIL  W4 res='||v_res2::text||' n='||v_n END;
  BEGIN
    PERFORM waive_late_fee(jsonb_build_object('waiver', jsonb_build_object('charge_id', v_charge, 'amount', 60, 'reason', 'more goodwill',
               'approver', 'owner', 'idempotency_key', 'w-2'), 'target', pg_temp.cols(v_tgt, -60)));
    v_out := v_out || E'\n' || 'FAIL  W5 total waivers above the fee accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'WAIVER_EXCEEDS_FEE%' THEN 'PASS  W5 second waiver of 60 with only 50 left rejected (WAIVER_EXCEEDS_FEE)' ELSE 'FAIL  W5 '||SQLERRM END;
  END;

  ---------------------------------------------------------------- R1 reversal needs a reason / R2 reversal / R3 replay
  BEGIN
    PERFORM reverse_late_fee_waiver(jsonb_build_object('reversal', jsonb_build_object('adjustment_id', v_adj, 'reason', E'\t', 'approver', 'owner'),
               'target', pg_temp.cols(v_tgt, 100)));
    v_out := v_out || E'\n' || 'FAIL  R1 reversal without reason accepted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'REASON_REQUIRED%' THEN 'PASS  R1 reversal with blank reason rejected (REASON_REQUIRED)' ELSE 'FAIL  R1 '||SQLERRM END;
  END;
  v_res := reverse_late_fee_waiver(jsonb_build_object('reversal', jsonb_build_object('adjustment_id', v_adj, 'reason', 'waiver approved by mistake', 'approver', 'owner'),
             'target', pg_temp.cols(v_tgt, 100)));
  v_rev := (v_res->>'adjustment_id')::uuid;
  SELECT total_amount::numeric(12,2) INTO v_st FROM invoices WHERE id = v_tgt;
  SELECT (e->>'waived_amount')||'/'||(e->>'total_amount') INTO v_msg
    FROM invoices i, jsonb_array_elements(i.additional_fees_breakdown) e WHERE i.id = v_tgt AND e->>'late_fee_charge_id' = v_charge::text;
  SELECT count(*), COALESCE(sum(amount),0) INTO v_n, v_num FROM adjustments WHERE source = 'late_fee_charge:'||v_charge;
  v_out := v_out || E'\n' || CASE WHEN v_st = '3350.00' AND v_msg = '0.00/150.00' AND v_n = 2 AND v_num = 0
       AND EXISTS (SELECT 1 FROM adjustments WHERE id = v_rev AND type = 'reversal' AND amount = -100 AND reverses_adjustment_id = v_adj)
       AND EXISTS (SELECT 1 FROM adjustments WHERE id = v_adj) AND pg_temp.engine_ok(v_tgt)
    THEN 'PASS  R2 reversal: paired -100 row, original waiver kept, net waived 0, line back to 150, total 3350'
    ELSE 'FAIL  R2 total='||v_st||' line='||v_msg||' rows='||v_n||' net='||v_num END;
  v_res2 := reverse_late_fee_waiver(jsonb_build_object('reversal', jsonb_build_object('adjustment_id', v_adj, 'reason', 'again', 'approver', 'owner'),
             'target', pg_temp.cols(v_tgt, 100)));
  SELECT count(*) INTO v_n FROM adjustments WHERE reverses_adjustment_id = v_adj;
  v_out := v_out || E'\n' || CASE WHEN (v_res2->>'replayed')::boolean AND v_n = 1 THEN 'PASS  R3 second reversal replayed (1 reversal row)' ELSE 'FAIL  R3 '||v_res2::text END;
  BEGIN
    DELETE FROM adjustments WHERE id = v_adj;
    v_out := v_out || E'\n' || 'FAIL  R4 waiver deleted';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || 'PASS  R4 waiver rows cannot be deleted ('||SQLERRM||')';
  END;

  ---------------------------------------------------------------- T1 total consistency after the whole sequence
  SELECT (SELECT COALESCE(sum((e->>'total_amount')::numeric),0) FROM jsonb_array_elements(additional_fees_breakdown) e WHERE e->>'item_type'='late_fee_line')
    INTO v_num FROM invoices WHERE id = v_tgt;
  SELECT count(*) INTO v_n FROM late_fee_charges c WHERE c.target_invoice_id = v_tgt
     AND v_num = (SELECT sum(c2.amount - COALESCE((SELECT sum(a.amount) FROM adjustments a WHERE a.source = 'late_fee_charge:'||c2.id),0))
                  FROM late_fee_charges c2 WHERE c2.target_invoice_id = v_tgt);
  v_out := v_out || E'\n' || CASE WHEN pg_temp.engine_ok(v_tgt) AND v_n = 1
    THEN 'PASS  T1 target total = engine identity, and late-fee lines = charges - net adjustments ('||v_num||')'
    ELSE 'FAIL  T1 lines='||v_num||' match='||v_n||' engine='||pg_temp.engine_ok(v_tgt) END;
  SELECT count(*) INTO v_n FROM invoices WHERE id = v_src AND total_amount = 3000 AND COALESCE(additional_fees_breakdown, '[]'::jsonb) = '[]'::jsonb AND COALESCE(late_fee_amount,0) = 0;
  v_out := v_out || E'\n' || CASE WHEN v_n = 1 THEN 'PASS  T2 source invoice untouched (fee lives on the later invoice only)' ELSE 'FAIL  T2 source changed' END;

  ---------------------------------------------------------------- A1 automation: allowed only under auto_post and only for invoices due after the policy existed
  v_res := create_late_fee_policy(jsonb_build_object('effective_from','2026-01-01','rate_kind','flat_per_day','rate_value',50,
            'auto_post',true,'created_by','tester'));
  v_auto_ver := (v_res->>'version')::int;
  BEGIN
    PERFORM post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_src, v_tgt, '2026-09-09', '2026-09-10', 100, v_auto_ver, 'automation:test'),
                                                     'target', pg_temp.cols(v_tgt, 100)));
    v_out := v_out || E'\n' || 'FAIL  A1 automation posted on an invoice that fell due before the policy existed';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || CASE WHEN SQLERRM LIKE 'AUTO_POST_HISTORICAL%' THEN 'PASS  A1 historical invoice needs admin approval even under auto_post (AUTO_POST_HISTORICAL)' ELSE 'FAIL  A1 '||SQLERRM END;
  END;
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, total_amount, status)
    VALUES (v_ta, v_room, current_date, current_date + 1, current_date + 400, current_date + 430, 3000, 3000, 'overdue') RETURNING id INTO v_future_src;
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, total_amount, status)
    VALUES (v_ta, v_room, current_date, current_date + 40, current_date + 431, current_date + 460, 3000, 3000, 'pending') RETURNING id INTO v_future_tgt;
  v_res := post_late_fee_charge(jsonb_build_object('charge', pg_temp.charge(v_future_src, v_future_tgt, current_date + 2, current_date + 3, 100, v_auto_ver, 'automation:test'),
                                                    'target', pg_temp.cols(v_future_tgt, 100)));
  SELECT count(*) INTO v_n FROM money_events WHERE action = 'late_fee.post' AND invoice_id = v_future_tgt
     AND actor_user_id = 'automation:test' AND (after->>'automated')::boolean;
  v_out := v_out || E'\n' || CASE WHEN v_n = 1 AND (v_res->>'replayed')::boolean = false
    THEN 'PASS  A2 automation posts under an auto_post policy and is logged as automation:test'
    ELSE 'FAIL  A2 res='||v_res::text||' events='||v_n END;

  RAISE EXCEPTION 'RESULT: %', v_out;
END
$t$;
