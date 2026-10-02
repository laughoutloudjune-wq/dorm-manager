-- Rollback-wrapped tests for append-only triggers and uniqueness rules:
-- money_events, adjustments, tenant_credits, refund_payouts (void-once), late_fee_charges / late_fee_policies.
-- Run ONLY on the dummy project dorm-test (rghxelkifdrpvabyxopb). Never on production.
-- Nothing persists: the DO block ends with RAISE EXCEPTION 'RESULT: ...'.
-- Case statuses: PASS | FAIL | PROBE (see 01_record_payment_batch.sql).

-- Helper: run a statement that MUST fail with a message containing p_pattern (inside a savepoint).
CREATE OR REPLACE FUNCTION pg_temp.expect_err(p_label text, p_sql text, p_pattern text)
RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%'||p_pattern||'%' THEN
      RETURN 'PASS  '||p_label||' ('||left(SQLERRM, 110)||')';
    END IF;
    RETURN 'FAIL  '||p_label||' wrong error: '||left(SQLERRM, 160);
  END;
  RETURN 'FAIL  '||p_label||' statement SUCCEEDED but should have been rejected';
END $f$;

-- Helper: run a statement that MUST succeed.
CREATE OR REPLACE FUNCTION pg_temp.expect_ok(p_label text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN 'PASS  '||p_label;
EXCEPTION WHEN OTHERS THEN
  RETURN 'FAIL  '||p_label||' unexpectedly rejected: '||left(SQLERRM, 160);
END $f$;

DO $t$
DECLARE
  v_out text := '';
  v_t uuid := gen_random_uuid();
  v_inv uuid := gen_random_uuid();
  v_adj uuid; v_rp uuid; v_n numeric; v_msg text;
BEGIN
  ------------------------------------------------------------ money_events
  INSERT INTO money_events(action, actor_user_id, tenant_id, reason) VALUES ('test.event','tester',v_t,'seed');
  v_out := v_out || E'\n' || pg_temp.expect_err('M1 money_events UPDATE blocked', format('UPDATE money_events SET reason=''x'' WHERE tenant_id=%L', v_t), 'append-only');
  v_out := v_out || E'\n' || pg_temp.expect_err('M2 money_events DELETE blocked', format('DELETE FROM money_events WHERE tenant_id=%L', v_t), 'append-only');
  v_out := v_out || E'\n' || pg_temp.expect_err('M3 money_events bulk UPDATE blocked', 'UPDATE money_events SET reason = reason', 'append-only');

  ------------------------------------------------------------ adjustments
  INSERT INTO adjustments(type, amount, invoice_id, tenant_id, reason, actor, reference_key)
    VALUES ('discount', 100, v_inv, v_t, 'goodwill', 'tester', 'adj-ref-1') RETURNING id INTO v_adj;
  v_out := v_out || E'\n' || pg_temp.expect_err('A1 adjustments UPDATE blocked', format('UPDATE adjustments SET amount=5 WHERE id=%L', v_adj), 'append-only');
  v_out := v_out || E'\n' || pg_temp.expect_err('A2 adjustments DELETE blocked', format('DELETE FROM adjustments WHERE id=%L', v_adj), 'append-only');
  v_out := v_out || E'\n' || pg_temp.expect_err('A3 duplicate reference_key rejected',
    format('INSERT INTO adjustments(type,amount,reason,reference_key) VALUES (''waiver'',5,''r'',''adj-ref-1'')'), 'uq_adjustments_reference_key');
  v_out := v_out || E'\n' || pg_temp.expect_err('A4 zero amount rejected',
    'INSERT INTO adjustments(type,amount,reason) VALUES (''discount'',0,''r'')', 'adjustments_amount_nonzero');
  v_out := v_out || E'\n' || pg_temp.expect_err('A5 blank (spaces) reason rejected',
    'INSERT INTO adjustments(type,amount,reason) VALUES (''discount'',5,''   '')', 'adjustments_reason_not_blank');
  v_out := v_out || E'\n' || pg_temp.expect_err('A6 reversal without reverses_adjustment_id rejected',
    'INSERT INTO adjustments(type,amount,reason) VALUES (''reversal'',-5,''oops'')', 'adjustments_reversal_link_check');
  v_out := v_out || E'\n' || pg_temp.expect_err('A7 non-reversal carrying a reverses id rejected',
    format('INSERT INTO adjustments(type,amount,reason,reverses_adjustment_id) VALUES (''discount'',5,''r'',%L)', v_adj), 'adjustments_reversal_link_check');
  v_out := v_out || E'\n' || pg_temp.expect_err('A8 invalid type rejected',
    'INSERT INTO adjustments(type,amount,reason) VALUES (''freebie'',5,''r'')', 'adjustments_type_check');
  v_out := v_out || E'\n' || pg_temp.expect_ok('A9 first reversal accepted',
    format('INSERT INTO adjustments(type,amount,reason,reverses_adjustment_id) VALUES (''reversal'',-100,''undo'',%L)', v_adj));
  v_out := v_out || E'\n' || pg_temp.expect_err('A10 second reversal of same adjustment rejected',
    format('INSERT INTO adjustments(type,amount,reason,reverses_adjustment_id) VALUES (''reversal'',-100,''undo again'',%L)', v_adj), 'uq_adjustments_single_reversal');

  ------------------------------------------------------------ tenant_credits
  INSERT INTO tenant_credits(tenant_id, kind, bucket, amount) VALUES (v_t, 'overpayment', 'unapplied', 300);
  v_out := v_out || E'\n' || pg_temp.expect_err('T1 tenant_credits UPDATE blocked', format('UPDATE tenant_credits SET amount=1 WHERE tenant_id=%L', v_t), 'append-only');
  v_out := v_out || E'\n' || pg_temp.expect_err('T2 tenant_credits DELETE blocked', format('DELETE FROM tenant_credits WHERE tenant_id=%L', v_t), 'append-only');
  v_out := v_out || E'\n' || pg_temp.expect_err('T3 negative overpayment rejected',
    format('INSERT INTO tenant_credits(tenant_id,kind,bucket,amount) VALUES (%L,''overpayment'',''unapplied'',-5)', v_t), 'tenant_credits_in_kind_bucket');
  v_out := v_out || E'\n' || pg_temp.expect_err('T4 overpayment in wrong bucket rejected',
    format('INSERT INTO tenant_credits(tenant_id,kind,bucket,amount) VALUES (%L,''overpayment'',''deposit'',5)', v_t), 'tenant_credits_in_kind_bucket');
  v_out := v_out || E'\n' || pg_temp.expect_err('T5 positive refunded rejected',
    format('INSERT INTO tenant_credits(tenant_id,kind,bucket,amount,reason) VALUES (%L,''refunded'',''unapplied'',5,''r'')', v_t), 'tenant_credits_in_kind_bucket');
  v_out := v_out || E'\n' || pg_temp.expect_err('T6 forfeited without reason rejected',
    format('INSERT INTO tenant_credits(tenant_id,kind,bucket,amount) VALUES (%L,''forfeited'',''deposit'',-5)', v_t), 'tenant_credits_reason_check');
  v_out := v_out || E'\n' || pg_temp.expect_err('T7 zero amount rejected',
    format('INSERT INTO tenant_credits(tenant_id,kind,bucket,amount) VALUES (%L,''overpayment'',''unapplied'',0)', v_t), 'tenant_credits_amount_nonzero');
  v_out := v_out || E'\n' || pg_temp.expect_ok('T8 reversal row with reason accepted',
    format('INSERT INTO tenant_credits(tenant_id,kind,bucket,amount,reason) VALUES (%L,''reversal'',''unapplied'',-300,''void'')', v_t));
  SELECT unapplied_credit INTO v_n FROM tenant_credit_balances WHERE tenant_id = v_t;
  v_out := v_out || E'\n' || CASE WHEN v_n = 0 THEN 'PASS  T9 tenant_credit_balances nets overpayment + reversal to 0' ELSE 'FAIL  T9 balance='||v_n END;

  ------------------------------------------------------------ refund_payouts (void exactly once)
  INSERT INTO refund_payouts(tenant_id, amount, paid_at, idempotency_key) VALUES (v_t, 500, now(), 'rp-key-1') RETURNING id INTO v_rp;
  v_out := v_out || E'\n' || pg_temp.expect_err('R1 refund_payouts DELETE blocked', format('DELETE FROM refund_payouts WHERE id=%L', v_rp), 'append-only');
  v_out := v_out || E'\n' || pg_temp.expect_err('R2 duplicate idempotency_key rejected',
    format('INSERT INTO refund_payouts(tenant_id,amount,paid_at,idempotency_key) VALUES (%L,5,now(),''rp-key-1'')', v_t), 'refund_payouts_idempotency_key_unique');
  v_out := v_out || E'\n' || pg_temp.expect_err('R3 amount <= 0 rejected',
    format('INSERT INTO refund_payouts(tenant_id,amount,paid_at,idempotency_key) VALUES (%L,0,now(),''rp-key-2'')', v_t), 'refund_payouts_amount_positive');
  v_out := v_out || E'\n' || pg_temp.expect_err('R4 plain UPDATE (no void) blocked', format('UPDATE refund_payouts SET recipient=''x'' WHERE id=%L', v_rp), 'only a void is allowed');
  v_out := v_out || E'\n' || pg_temp.expect_err('R5 void that also changes amount blocked',
    format('UPDATE refund_payouts SET voided_at=now(), void_reason=''r'', amount=1 WHERE id=%L', v_rp), 'only void columns may change');
  v_out := v_out || E'\n' || pg_temp.expect_err('R6 void with blank reason rejected',
    format('UPDATE refund_payouts SET voided_at=now(), void_reason=''  '' WHERE id=%L', v_rp), 'refund_payouts_void_consistent');
  v_out := v_out || E'\n' || pg_temp.expect_err('R7 void without reason rejected',
    format('UPDATE refund_payouts SET voided_at=now() WHERE id=%L', v_rp), 'refund_payouts_void_consistent');
  v_out := v_out || E'\n' || pg_temp.expect_ok('R8 first void accepted',
    format('UPDATE refund_payouts SET voided_at=now(), voided_by=''tester'', void_reason=''wrong account'' WHERE id=%L', v_rp));
  v_out := v_out || E'\n' || pg_temp.expect_err('R9 second void rejected', format('UPDATE refund_payouts SET voided_at=now(), void_reason=''again'' WHERE id=%L', v_rp), 'already voided');
  v_out := v_out || E'\n' || pg_temp.expect_err('R10 un-voiding rejected', format('UPDATE refund_payouts SET voided_at=NULL, void_reason=NULL WHERE id=%L', v_rp), 'already voided');
  v_out := v_out || E'\n' || pg_temp.expect_err('R11 DELETE of voided payout blocked', format('DELETE FROM refund_payouts WHERE id=%L', v_rp), 'append-only');
  SELECT refund_paid INTO v_n FROM refund_due_vs_paid WHERE tenant_id = v_t;
  v_out := v_out || E'\n' || CASE WHEN COALESCE(v_n,0) = 0 THEN 'PASS  R12 refund_due_vs_paid ignores voided payout (paid=0)' ELSE 'FAIL  R12 refund_paid='||v_n END;

  ------------------------------------------------------------ late_fee_charges / policies
  INSERT INTO late_fee_policies(version, effective_from, rate_kind, rate_value) VALUES (990001, current_date, 'flat_per_day', 50);
  INSERT INTO late_fee_charges(source_invoice_id, covered_from, covered_to, eligible_balance, rate_kind, rate_value, formula, policy_version, amount, posted_by)
    VALUES (v_inv, '2026-09-01', '2026-09-10', 1000, 'flat_per_day', 50, '10 days x 50 = 500', 990001, 500, 'tester');
  v_out := v_out || E'\n' || pg_temp.expect_err('L1 duplicate late fee posting (same invoice/period/policy) rejected',
    format('INSERT INTO late_fee_charges(source_invoice_id,covered_from,covered_to,eligible_balance,rate_kind,rate_value,formula,policy_version,amount,posted_by) VALUES (%L,''2026-09-01'',''2026-09-10'',1000,''flat_per_day'',50,''dup'',990001,500,''tester2'')', v_inv),
    'uq_late_fee_charge_period');
  v_out := v_out || E'\n' || pg_temp.expect_ok('L2 same period under a NEW policy version accepted',
    format('INSERT INTO late_fee_charges(source_invoice_id,covered_from,covered_to,eligible_balance,rate_kind,rate_value,formula,policy_version,amount,posted_by) VALUES (%L,''2026-09-01'',''2026-09-10'',1000,''flat_per_day'',60,''10 x 60'',990002,600,''tester'')', v_inv));
  v_out := v_out || E'\n' || pg_temp.expect_ok('L3 different period same policy accepted',
    format('INSERT INTO late_fee_charges(source_invoice_id,covered_from,covered_to,eligible_balance,rate_kind,rate_value,formula,policy_version,amount,posted_by) VALUES (%L,''2026-09-11'',''2026-09-12'',1000,''flat_per_day'',50,''2 x 50'',990001,100,''tester'')', v_inv));
  v_out := v_out || E'\n' || pg_temp.expect_err('L4 late_fee_charges UPDATE blocked', format('UPDATE late_fee_charges SET amount=1 WHERE source_invoice_id=%L', v_inv), 'append-only');
  v_out := v_out || E'\n' || pg_temp.expect_err('L5 late_fee_charges DELETE blocked', format('DELETE FROM late_fee_charges WHERE source_invoice_id=%L', v_inv), 'append-only');
  v_out := v_out || E'\n' || pg_temp.expect_err('L6 blank formula rejected',
    format('INSERT INTO late_fee_charges(source_invoice_id,covered_from,covered_to,eligible_balance,rate_kind,rate_value,formula,policy_version,amount,posted_by) VALUES (%L,''2026-10-01'',''2026-10-02'',1,''x'',1,'' '',990001,1,''t'')', v_inv), 'late_fee_charges_formula_check');
  v_out := v_out || E'\n' || pg_temp.expect_err('L7 covered_to before covered_from rejected',
    format('INSERT INTO late_fee_charges(source_invoice_id,covered_from,covered_to,eligible_balance,rate_kind,rate_value,formula,policy_version,amount,posted_by) VALUES (%L,''2026-10-05'',''2026-10-02'',1,''x'',1,''f'',990001,1,''t'')', v_inv), 'late_fee_charges_period_check');
  v_out := v_out || E'\n' || pg_temp.expect_err('L8 late_fee_policies UPDATE blocked', 'UPDATE late_fee_policies SET rate_value = 1 WHERE version = 990001', 'append-only');
  v_out := v_out || E'\n' || pg_temp.expect_err('L9 late_fee_policies DELETE blocked', 'DELETE FROM late_fee_policies WHERE version = 990001', 'append-only');
  v_out := v_out || E'\n' || pg_temp.expect_err('L10 duplicate policy version rejected',
    'INSERT INTO late_fee_policies(version, effective_from, rate_kind, rate_value) VALUES (990001, current_date, ''flat_once'', 1)', 'late_fee_policies_version_unique');

  ------------------------------------------------------------ Probes
  -- P1/P2: btrim() only strips spaces. A reason made of tab/newline passes every "not blank" CHECK.
  BEGIN
    INSERT INTO adjustments(type,amount,reason) VALUES ('discount',7,E'\t\n');
    v_out := v_out || E'\n' || 'PROBE  P1 adjustments.reason = tab+newline only was ACCEPTED (btrim strips spaces only; blank-reason CHECK bypassed)';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || 'PROBE  P1 tab+newline reason rejected: '||SQLERRM;
  END;
  INSERT INTO refund_payouts(tenant_id, amount, paid_at, idempotency_key) VALUES (v_t, 50, now(), 'rp-key-p2') RETURNING id INTO v_rp;
  BEGIN
    UPDATE refund_payouts SET voided_at=now(), void_reason=E'\t' WHERE id = v_rp;
    v_out := v_out || E'\n' || 'PROBE  P2 refund_payouts void_reason = tab only was ACCEPTED (same btrim weakness)';
  EXCEPTION WHEN OTHERS THEN
    v_out := v_out || E'\n' || 'PROBE  P2 tab-only void_reason rejected: '||SQLERRM;
  END;

  RAISE EXCEPTION 'RESULT:%', v_out;
END
$t$;
