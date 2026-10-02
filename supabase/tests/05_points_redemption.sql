-- Rollback-wrapped tests for public.redeem_points_atomic() / public.reverse_points_redemption()
-- (migration 20261002000700). Run ONLY on dorm-test (rghxelkifdrpvabyxopb). Never on production.
-- Nothing persists: the DO block ends with RAISE EXCEPTION 'RESULT: ...', which rolls everything back.
-- Paste the whole file into execute_sql. Line prefixes as in README.md (PASS | FAIL | PROBE).
--
-- The pg_temp helpers build the caller payload the way lib/points-ledger.ts does: `expected` is the
-- invoice row as read, `new` is expected -/+ the discount (what toInvoiceMoneyColumns produces when
-- only the discount term changes). Each helper returns the function result, or {"error": SQLERRM}.

CREATE OR REPLACE FUNCTION pg_temp.exp_of(p_inv uuid) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('total_amount', total_amount, 'discount_amount', COALESCE(discount_amount,0),
    'paid_amount', COALESCE(paid_amount,0), 'late_fee_amount', COALESCE(late_fee_amount,0),
    'additional_fees_total', COALESCE(additional_fees_total,0), 'carry_forward_amount', COALESCE(carry_forward_amount,0),
    'rent_amount', COALESCE(rent_amount,0), 'water_bill', COALESCE(water_bill,0),
    'electricity_bill', COALESCE(electricity_bill,0), 'common_fee', COALESCE(common_fee,0))
  FROM public.invoices WHERE id = p_inv
$f$;

CREATE OR REPLACE FUNCTION pg_temp.new_of(p_exp jsonb, p_delta numeric) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('total_amount', (p_exp->>'total_amount')::numeric - p_delta,
    'discount_amount', (p_exp->>'discount_amount')::numeric + p_delta,
    'late_fee_amount', p_exp->'late_fee_amount', 'additional_fees_total', p_exp->'additional_fees_total',
    'carry_forward_amount', p_exp->'carry_forward_amount')
$f$;

CREATE OR REPLACE FUNCTION pg_temp.redeem(p_tenant uuid, p_inv uuid, p_points int, p_key text,
    p_target text DEFAULT 'rent', p_max_month int DEFAULT 99, p_baht numeric DEFAULT NULL,
    p_exp jsonb DEFAULT NULL, p_new jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_exp jsonb; v_baht numeric;
BEGIN
  v_exp := COALESCE(p_exp, pg_temp.exp_of(p_inv));
  v_baht := COALESCE(p_baht, round(p_points / 10.0, 2));
  RETURN public.redeem_points_atomic(jsonb_build_object(
    'tenant_id', p_tenant, 'invoice_id', p_inv, 'target', p_target, 'reference_key', p_key,
    'points_to_spend', p_points, 'baht_applied', v_baht, 'points_per_baht', 10,
    'max_redemption_baht', 300, 'max_redemptions_per_month', p_max_month,
    'expected', v_exp, 'new', COALESCE(p_new, pg_temp.new_of(v_exp, v_baht)), 'actor', 'tester'));
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('error', SQLERRM);
END $f$;

CREATE OR REPLACE FUNCTION pg_temp.reverse(p_entry uuid, p_reason text, p_exp jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_exp jsonb; v_inv uuid; v_baht numeric;
BEGIN
  SELECT reference_id, baht_equivalent INTO v_inv, v_baht FROM public.point_ledger_entries WHERE id = p_entry;
  v_exp := COALESCE(p_exp, pg_temp.exp_of(v_inv));
  RETURN public.reverse_points_redemption(jsonb_build_object(
    'entry_id', p_entry, 'reason', p_reason, 'expected', v_exp,
    'new', pg_temp.new_of(v_exp, -COALESCE(v_baht, 0)), 'actor', 'tester'));
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('error', SQLERRM);
END $f$;

CREATE OR REPLACE FUNCTION pg_temp.balance(p_tenant uuid) RETURNS bigint LANGUAGE sql AS $f$
  SELECT COALESCE(SUM(points),0) FROM public.point_ledger_entries
  WHERE tenant_id = p_tenant AND (expires_at IS NULL OR expires_at > now())
$f$;

CREATE OR REPLACE FUNCTION pg_temp.line(p_ok boolean, p_label text, p_detail text) RETURNS text LANGUAGE sql AS $f$
  SELECT E'\n' || CASE WHEN p_ok THEN 'PASS  ' ELSE 'FAIL  ' END || p_label || ' (' || COALESCE(p_detail, 'null') || ')'
$f$;

DO $t$
DECLARE
  v_out text := '';
  v_room uuid; v_ta uuid; v_tb uuid; v_tc uuid;
  v_i1 uuid; v_i2 uuid; v_i3 uuid; v_i4 uuid; v_i5 uuid; v_i6 uuid; v_i7 uuid; v_i8 uuid;
  v_res jsonb; v_res2 jsonb; v_exp jsonb; v_entry uuid; v_legacy uuid;
  v_n int; v_n2 int; v_msg text; v_num numeric; v_b0 bigint;
BEGIN
  INSERT INTO rooms(room_number) VALUES ('T-'||gen_random_uuid()) RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id) VALUES ('Pts A', current_date, v_room) RETURNING id INTO v_ta;
  -- B and C are inactive (one active tenant per room); the functions do not look at tenant status.
  INSERT INTO tenants(full_name, move_in_date, room_id, status) VALUES ('Pts B', current_date, v_room, 'inactive') RETURNING id INTO v_tb;
  INSERT INTO tenants(full_name, move_in_date, room_id, status) VALUES ('Pts C', current_date, v_room, 'inactive') RETURNING id INTO v_tc;
  INSERT INTO point_ledger_entries(tenant_id, points, reason, baht_equivalent, idempotency_key, expires_at)
    VALUES (v_ta, 5000, 'manual_adjustment', 500, 't05-earn-a', now() + interval '1 year'),
           (v_tb, 100, 'manual_adjustment', 10, 't05-earn-b', now() + interval '1 year'),
           (v_tc, 20000, 'manual_adjustment', 2000, 't05-earn-c', now() + interval '1 year');

  -- i1: rent 3000, water 200, elec 300 -> total 3500 (tenant A)
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, water_bill,
      electricity_bill, total_amount, status)
    VALUES (v_ta, v_room, current_date, current_date, current_date, current_date, 3000, 200, 300, 3500, 'pending')
    RETURNING id INTO v_i1;
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, water_bill,
      electricity_bill, total_amount, status)
    VALUES (v_ta, v_room, current_date, current_date, current_date, current_date, 3000, 200, 300, 3500, 'pending')
    RETURNING id INTO v_i2;

  ------------------------------------------------------------ P1 normal redemption writes both sides
  v_b0 := pg_temp.balance(v_ta);
  v_res := pg_temp.redeem(v_ta, v_i1, 1500, 't05-k1', 'rent', 1);
  v_entry := (v_res->'ledger_entry'->>'id')::uuid;
  SELECT 'replay='||(v_res->>'replay')||' ledger='||(SELECT points||'/'||reason||'/'||baht_equivalent FROM point_ledger_entries WHERE idempotency_key='t05-k1')
       ||' adj='||(SELECT type||'/'||amount||'/'||source FROM adjustments WHERE reference_key='t05-k1')
       ||' inv='||total_amount::numeric(12,2)||'/'||discount_amount::numeric(12,2)||'/paid '||COALESCE(paid_amount,0)::numeric(12,2)
       ||' lines='||jsonb_array_length(discount_breakdown)||' key_on_line='||(discount_breakdown->0->>'reference_key')
       ||' events='||(SELECT count(*) FROM money_events WHERE invoice_id=v_i1 AND action='points.redeem')
       ||' batches='||(SELECT count(*) FROM payment_batches WHERE trigger_invoice_id=v_i1)
       ||' balance='||v_b0||'->'||pg_temp.balance(v_ta)
    INTO v_msg FROM invoices WHERE id=v_i1;
  v_out := v_out || pg_temp.line(v_msg = 'replay=false ledger=-1500/redemption/150.00 adj=points_redemption/150.00/points_redemption inv=3350.00/150.00/paid 0.00 lines=1 key_on_line=t05-k1 events=1 batches=0 balance=5000->3500',
    'P1 redeem 1500 pts -> 150 baht: ledger + adjustment + invoice + event, cash untouched', v_msg);

  ------------------------------------------------------------ P2 replay
  v_res := pg_temp.redeem(v_ta, v_i1, 1500, 't05-k1', 'rent', 1);
  SELECT count(*) INTO v_n FROM point_ledger_entries WHERE tenant_id=v_ta AND reason='redemption';
  SELECT count(*) INTO v_n2 FROM adjustments WHERE invoice_id=v_i1;
  SELECT total_amount INTO v_num FROM invoices WHERE id=v_i1;
  v_msg := 'replay='||COALESCE(v_res->>'replay', v_res->>'error')||' same_entry='||((v_res->'ledger_entry'->>'id')::uuid = v_entry)
           ||' redemptions='||v_n||' adjs='||v_n2||' total='||v_num::numeric(12,2)||' balance='||pg_temp.balance(v_ta);
  v_out := v_out || pg_temp.line(v_msg = 'replay=true same_entry=true redemptions=1 adjs=1 total=3350.00 balance=3500',
    'P2 same key replays (even though the monthly limit is now used), nothing new written', v_msg);

  v_res := pg_temp.redeem(v_ta, v_i2, 1500, 't05-k1', 'rent', 99);
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'IDEMPOTENCY_KEY_REUSED%',
    'P2b same key on a different invoice rejected', COALESCE(v_res->>'error', v_res::text));

  INSERT INTO adjustments(type, amount, invoice_id, tenant_id, reason, reference_key)
    VALUES ('discount', 1, v_i2, v_ta, 'unrelated', 't05-foreign');
  v_res := pg_temp.redeem(v_ta, v_i2, 100, 't05-foreign', 'rent', 99);
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'IDEMPOTENCY_KEY_REUSED%',
    'P2c key already used by an unrelated adjustment rejected (unique across both writes)', COALESCE(v_res->>'error', v_res::text));

  ------------------------------------------------------------ P3 key required
  v_res := pg_temp.redeem(v_ta, v_i2, 100, E' \t', 'rent', 99);
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'A reference key is required%',
    'P3 blank/whitespace key rejected', COALESCE(v_res->>'error', v_res::text));

  ------------------------------------------------------------ P4 monthly limit (A used 1 of 1)
  v_res := pg_temp.redeem(v_ta, v_i2, 100, 't05-k2', 'rent', 1);
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'MONTHLY_LIMIT%',
    'P4 second redemption in the same Bangkok month rejected at limit 1', COALESCE(v_res->>'error', v_res::text));
  v_res := pg_temp.redeem(v_ta, v_i2, 100, 't05-k2', 'rent', 2);
  v_out := v_out || pg_temp.line((v_res->>'replay') = 'false',
    'P4b same request allowed at limit 2', COALESCE(v_res->>'error', 'ok'));

  ------------------------------------------------------------ P5 over-balance (B has 100 points)
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, total_amount, status)
    VALUES (v_tb, v_room, current_date, current_date, current_date, current_date, 3000, 3000, 'pending') RETURNING id INTO v_i3;
  v_res := pg_temp.redeem(v_tb, v_i3, 1500, 't05-k3');
  SELECT count(*) INTO v_n FROM point_ledger_entries WHERE tenant_id=v_tb AND reason='redemption';
  SELECT count(*) INTO v_n2 FROM adjustments WHERE invoice_id=v_i3;
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'INSUFFICIENT_POINTS%' AND v_n=0 AND v_n2=0
      AND (SELECT total_amount FROM invoices WHERE id=v_i3)=3000,
    'P5 redeem more than the balance rejected, nothing written', COALESCE(v_res->>'error', v_res::text));

  ------------------------------------------------------------ P6 discount cap excludes late fees / carried debt / common fee
  -- i4: rent 100, late fee 500, carried 1000, common 50 -> total 1650. Only 100 is discountable.
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, common_fee,
      late_fee_amount, carry_forward_amount, total_amount, status)
    VALUES (v_tc, v_room, current_date, current_date, current_date, current_date, 100, 50, 500, 1000, 1650, 'overdue')
    RETURNING id INTO v_i4;
  v_res := pg_temp.redeem(v_tc, v_i4, 3000, 't05-k4');
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'DISCOUNT_CAP%',
    'P6a 300 baht on rent 100 + late fee 500 + carry 1000 rejected', COALESCE(v_res->>'error', v_res::text));
  v_res := pg_temp.redeem(v_tc, v_i4, 1000, 't05-k4b');
  v_out := v_out || pg_temp.line((v_res->>'replay') = 'false' AND (v_res->'invoice'->>'total_amount')::numeric = 1550,
    'P6b exactly the rent (100 baht) accepted', COALESCE(v_res->>'error', v_res->'invoice'->>'total_amount'));
  v_res := pg_temp.redeem(v_tc, v_i4, 10, 't05-k4c');
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'DISCOUNT_CAP%',
    'P6c rent already fully discounted: 1 more baht rejected', COALESCE(v_res->>'error', v_res::text));

  -- i5: rent 1000, late fee 200, total 1200, paid 1000 (partial). Remainder is only late fee.
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, late_fee_amount,
      total_amount, paid_amount, status)
    VALUES (v_tc, v_room, current_date, current_date, current_date, current_date, 1000, 200, 1200, 1000, 'partial')
    RETURNING id INTO v_i5;
  v_res := pg_temp.redeem(v_tc, v_i5, 1000, 't05-k5');
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'DISCOUNT_CAP%',
    'P6d partly paid invoice whose remainder is only a late fee: rejected', COALESCE(v_res->>'error', v_res::text));

  -- i6: utility target limited to water + electricity (100), not rent.
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, water_bill,
      electricity_bill, total_amount, status)
    VALUES (v_tc, v_room, current_date, current_date, current_date, current_date, 3000, 50, 50, 3100, 'pending')
    RETURNING id INTO v_i6;
  v_res := pg_temp.redeem(v_tc, v_i6, 1500, 't05-k6', 'utility');
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'DISCOUNT_CAP%',
    'P6e utility coupon 150 on utilities 100 rejected', COALESCE(v_res->>'error', v_res::text));
  v_res := pg_temp.redeem(v_tc, v_i6, 3010, 't05-k6b', 'rent');
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'DISCOUNT_CAP%cap 300%',
    'P6f 301 baht over the per-redemption cap 300 rejected', COALESCE(v_res->>'error', v_res::text));

  ------------------------------------------------------------ P7 ratio / column consistency / invoice checks
  v_res := pg_temp.redeem(v_tc, v_i6, 1500, 't05-k7', 'rent', 99, 200);
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'RATIO_MISMATCH%',
    'P7a 1500 points claimed as 200 baht rejected', COALESCE(v_res->>'error', v_res::text));
  v_exp := pg_temp.exp_of(v_i6);
  v_res := pg_temp.redeem(v_tc, v_i6, 1500, 't05-k7b', 'rent', 99, NULL, v_exp,
                          pg_temp.new_of(v_exp, 150) || jsonb_build_object('total_amount', 3000));
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'INCONSISTENT_COLUMNS%',
    'P7b new total not equal to expected - discount rejected', COALESCE(v_res->>'error', v_res::text));
  v_res := pg_temp.redeem(v_tc, v_i6, 1500, 't05-k7c', 'rent', 99, NULL, v_exp,
                          pg_temp.new_of(v_exp, 150) || jsonb_build_object('carry_forward_amount', 5, 'total_amount', 2950));
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'INCONSISTENT_COLUMNS%',
    'P7c redemption that also changes another money column rejected', COALESCE(v_res->>'error', v_res::text));
  v_res := pg_temp.redeem(v_ta, v_i6, 100, 't05-k7d');
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'Invoice does not belong%',
    'P7d invoice of another tenant rejected', COALESCE(v_res->>'error', v_res::text));
  UPDATE invoices SET status='paid' WHERE id=v_i3;
  v_res := pg_temp.redeem(v_tb, v_i3, 10, 't05-k7e');
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE '%not open for redemption%',
    'P7e paid invoice rejected', COALESCE(v_res->>'error', v_res::text));

  ------------------------------------------------------------ C1 concurrent-style stale checks
  -- Two requests both computed from the same read of i6; the first commits, the second is stale.
  v_exp := pg_temp.exp_of(v_i6);
  v_res := pg_temp.redeem(v_tc, v_i6, 500, 't05-c1a', 'rent', 99, NULL, v_exp);
  v_res2 := pg_temp.redeem(v_tc, v_i6, 500, 't05-c1b', 'rent', 99, NULL, v_exp);
  SELECT count(*) INTO v_n FROM point_ledger_entries WHERE idempotency_key IN ('t05-c1a','t05-c1b');
  v_out := v_out || pg_temp.line((v_res->>'replay')='false' AND COALESCE(v_res2->>'error','') LIKE 'STALE_INVOICE%total_amount%' AND v_n=1,
    'C1a second request computed from the pre-redemption row rejected STALE_INVOICE', COALESCE(v_res2->>'error', v_res2::text));
  -- A payment lands between read and redeem (paid_amount changes): stale.
  v_exp := pg_temp.exp_of(v_i2);
  UPDATE invoices SET paid_amount = 100, status='partial' WHERE id = v_i2;
  v_res := pg_temp.redeem(v_ta, v_i2, 100, 't05-c1c', 'rent', 99, NULL, v_exp);
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'STALE_INVOICE%',
    'C1b paid_amount changed after the read rejected', COALESCE(v_res->>'error', v_res::text));
  -- Reversal computed from a stale row.
  v_exp := pg_temp.exp_of(v_i6);
  SELECT id INTO v_entry FROM point_ledger_entries WHERE idempotency_key='t05-c1a';
  UPDATE invoices SET water_bill = 60 WHERE id = v_i6;
  v_res := pg_temp.reverse(v_entry, 'stale test', v_exp);
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'STALE_INVOICE%water_bill%',
    'C1c reversal computed from a stale row rejected', COALESCE(v_res->>'error', v_res::text));

  ------------------------------------------------------------ R1 paired reversal
  SELECT id INTO v_entry FROM point_ledger_entries WHERE idempotency_key='t05-k1';
  v_b0 := pg_temp.balance(v_ta);
  v_res := pg_temp.reverse(v_entry, 'redeemed on the wrong invoice');
  SELECT 'rev='||(SELECT points||'/'||reason||'/'||(reverses_entry_id=v_entry)||'/'||idempotency_key FROM point_ledger_entries WHERE reverses_entry_id=v_entry)
       ||' adj='||(SELECT type||'/'||amount||'/'||(reverses_adjustment_id=(SELECT id FROM adjustments WHERE reference_key='t05-k1'))||'/'||reference_key FROM adjustments WHERE reference_key='t05-k1:reversal')
       ||' originals='||(SELECT count(*) FROM point_ledger_entries WHERE id=v_entry)||'+'||(SELECT count(*) FROM adjustments WHERE reference_key='t05-k1')
       ||' inv='||total_amount::numeric(12,2)||'/'||discount_amount::numeric(12,2)||' lines='||jsonb_array_length(discount_breakdown)
       ||' events='||(SELECT count(*) FROM money_events WHERE invoice_id=v_i1 AND action='points.redeem_reversal')
       ||' balance='||v_b0||'->'||pg_temp.balance(v_ta)
    INTO v_msg FROM invoices WHERE id=v_i1;
  v_out := v_out || pg_temp.line(v_msg = 'rev=1500/redemption_reversal/true/t05-k1:reversal adj=reversal/-150.00/true/t05-k1:reversal originals=1+1 inv=3500.00/0.00 lines=0 events=1 balance=3400->4900',
    'R1 reversal appends +points and -adjustment linked to the originals; originals kept; invoice restored', COALESCE(v_msg, v_res::text));

  ------------------------------------------------------------ R2 double reversal
  v_res := pg_temp.reverse(v_entry, 'again');
  SELECT count(*) INTO v_n FROM point_ledger_entries WHERE reverses_entry_id=v_entry;
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'ALREADY_REVERSED%' AND v_n=1,
    'R2 second reversal of the same redemption rejected', COALESCE(v_res->>'error', v_res::text));

  ------------------------------------------------------------ R3 limit accounting after reversal
  -- Tenant A has 2 redemptions this month (k1 reversed, k2 live). At limit 2 a third is refused:
  -- the reversal did not hand back k1's slot.
  v_res := pg_temp.redeem(v_ta, v_i1, 100, 't05-r3', 'rent', 2);
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'MONTHLY_LIMIT%',
    'R3 reversed redemption still counts toward the monthly limit', COALESCE(v_res->>'error', v_res::text));

  ------------------------------------------------------------ R4 input checks
  SELECT id INTO v_entry FROM point_ledger_entries WHERE idempotency_key='t05-k2';
  v_res := pg_temp.reverse(v_entry, E'\t\n ');
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'A reversal reason is required%',
    'R4a tab/newline-only reason rejected', COALESCE(v_res->>'error', v_res::text));
  SELECT id INTO v_entry FROM point_ledger_entries WHERE idempotency_key='t05-earn-a';
  v_res := pg_temp.reverse(v_entry, 'not a redemption');
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'Only redemption entries%',
    'R4b reversing an earn row rejected', COALESCE(v_res->>'error', v_res::text));
  SELECT id INTO v_entry FROM point_ledger_entries WHERE idempotency_key='t05-k1:reversal';
  v_res := pg_temp.reverse(v_entry, 'reverse the reversal');
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'Only redemption entries%',
    'R4c reversing a reversal rejected', COALESCE(v_res->>'error', v_res::text));

  ------------------------------------------------------------ R5 closed invoice
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, total_amount, status)
    VALUES (v_tc, v_room, current_date, current_date, current_date, current_date, 3000, 3000, 'pending') RETURNING id INTO v_i7;
  v_res := pg_temp.redeem(v_tc, v_i7, 1000, 't05-r5');
  UPDATE invoices SET status='paid', paid_amount=2900 WHERE id=v_i7;
  v_res := pg_temp.reverse((v_res->'ledger_entry'->>'id')::uuid, 'after paid');
  v_out := v_out || pg_temp.line(COALESCE(v_res->>'error','') LIKE 'INVOICE_CLOSED%',
    'R5 reversal on a paid invoice rejected (would create debt silently)', COALESCE(v_res->>'error', v_res::text));

  ------------------------------------------------------------ R6 legacy redemption (no key, no adjustment)
  INSERT INTO invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, rent_amount, total_amount,
      discount_amount, discount_breakdown, status)
    VALUES (v_tc, v_room, current_date, current_date, current_date, current_date, 3000, 2850, 150,
      '[{"detail":"rule","amount":20,"source":"rule"},{"detail":"old","amount":150,"total_amount":150,"source":"rewards_redemption"}]'::jsonb, 'pending')
    RETURNING id INTO v_i8;
  UPDATE invoices SET total_amount = 2850 WHERE id = v_i8;
  INSERT INTO point_ledger_entries(tenant_id, points, reason, reference_type, reference_id, baht_equivalent, created_at)
    VALUES (v_tc, -1500, 'redemption', 'invoice', v_i8, 150, now() - interval '40 days') RETURNING id INTO v_legacy;
  v_res := pg_temp.reverse(v_legacy, 'legacy cleanup');
  SELECT 'adj='||(SELECT type||'/'||amount||'/'||reference_key FROM adjustments WHERE invoice_id=v_i8)
       ||' inv='||total_amount::numeric(12,2)||'/'||discount_amount::numeric(12,2)
       ||' lines='||(SELECT string_agg(e->>'source', ',') FROM jsonb_array_elements(discount_breakdown) e)
    INTO v_msg FROM invoices WHERE id=v_i8;
  v_out := v_out || pg_temp.line(v_msg = 'adj=correction/-150.00/redemption:'||v_legacy||':reversal inv=3000.00/0.00 lines=rule',
    'R6 legacy redemption reversed via a correction adjustment; only its own display line removed', COALESCE(v_msg, v_res::text));

  ------------------------------------------------------------ A1 append-only / no deletion path
  BEGIN
    DELETE FROM adjustments WHERE reference_key='t05-k1';
    v_msg := 'deleted';
  EXCEPTION WHEN others THEN v_msg := SQLERRM; END;
  v_out := v_out || pg_temp.line(v_msg LIKE '%append-only%', 'A1a redemption adjustment cannot be deleted', v_msg);
  BEGIN
    DELETE FROM point_ledger_entries WHERE idempotency_key='t05-k1';
    v_msg := 'deleted';
  EXCEPTION WHEN others THEN v_msg := SQLERRM; END;
  v_out := v_out || pg_temp.line(v_msg LIKE '%reverses_entry_id%' OR v_msg LIKE '%foreign key%',
    'A1b reversed redemption ledger row cannot be deleted (FK RESTRICT from its reversal)', v_msg);
  BEGIN
    INSERT INTO point_ledger_entries(tenant_id, points, reason, baht_equivalent, reverses_entry_id)
      VALUES (v_ta, 10, 'manual_adjustment', 1, (SELECT id FROM point_ledger_entries WHERE idempotency_key='t05-k2'));
    v_msg := 'inserted';
  EXCEPTION WHEN others THEN v_msg := SQLERRM; END;
  v_out := v_out || pg_temp.line(v_msg LIKE '%point_ledger_reversal_link_check%',
    'A1c reverses_entry_id only allowed on redemption_reversal rows', v_msg);

  ------------------------------------------------------------ D1 pair reconciliation over everything written here
  SELECT count(*) INTO v_n
  FROM point_ledger_entries e
  LEFT JOIN adjustments a ON a.reference_key = COALESCE(e.idempotency_key, 'redemption:'||e.id)
  WHERE e.tenant_id IN (v_ta, v_tb, v_tc) AND e.reason IN ('redemption','redemption_reversal')
    AND e.reference_id <> v_i8   -- the legacy original has no adjustment by design
    AND (a.id IS NULL OR abs(a.amount) <> e.baht_equivalent OR sign(a.amount) = sign(e.points));
  v_out := v_out || pg_temp.line(v_n = 0, 'D1 every redemption/reversal row has an opposite-signed adjustment of equal baht under the same key', 'mismatches='||v_n);

  RAISE EXCEPTION 'RESULT:%', v_out;
END $t$;
