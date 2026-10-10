-- Rollback-wrapped tests: the late fee frozen when carry-forward propagation marks an invoice paid
-- (item 3). Run ONLY on the dummy project dorm-test (rghxelkifdrpvabyxopb). Never on production.
-- Nothing persists: the block ends with RAISE EXCEPTION 'RESULT: ...'.
--
-- P1-P9  money_late_fee_amount parity with calculateLateFeeAmount (same fixtures as lib/money/late-fee-freeze.test.ts)
-- U1     paying a source freezes the fee of the target it settles, as of the PAYMENT date string
-- U2     a fee that is already frozen is never overwritten
-- U3     voiding the source unfreezes the target again
-- U4     move-out credit that pays an older invoice freezes that invoice and its downstream target

CREATE OR REPLACE FUNCTION pg_temp.ni(p_tenant uuid, p_room uuid, p_total numeric, p_carry numeric, p_paid numeric,
                                      p_status text, p_due date, p_start date, p_rate numeric)
RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO public.invoices(tenant_id, room_id, issue_date, due_date, start_date, end_date, total_amount, carry_forward_amount,
                              paid_amount, status, late_fee_start_date, late_fee_per_day)
  VALUES (p_tenant, p_room, current_date, p_due, current_date, current_date, p_total, p_carry, p_paid,
          p_status::public.invoice_status, p_start, p_rate) RETURNING id
$f$;

CREATE OR REPLACE FUNCTION pg_temp.st(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT paid_amount::numeric(12,2) || '/' || status || '/' || COALESCE(locked_late_fee_amount::text, 'NULL')
  FROM public.invoices WHERE id = p_id
$f$;

CREATE OR REPLACE FUNCTION pg_temp.pay(p_tenant uuid, p_inv uuid, p_amount numeric, p_key text, p_paid_at text)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE r public.invoices%ROWTYPE; v_new numeric; v_status public.invoice_status; v_id uuid := gen_random_uuid(); v_res jsonb;
BEGIN
  SELECT * INTO r FROM public.invoices WHERE id = p_inv;
  v_new := r.paid_amount + p_amount;
  v_status := public.money_derive_invoice_status_cf(p_inv, r.total_amount, v_new, r.due_date,
                (now() AT TIME ZONE 'Asia/Bangkok')::date, jsonb_build_object(p_inv::text, v_new));
  v_res := public.record_payment_batch(jsonb_build_object(
    'batch', jsonb_build_object('id', v_id, 'tenant_id', p_tenant, 'trigger_invoice_id', p_inv, 'amount_received', p_amount,
              'amount_allocated', p_amount, 'paid_at', p_paid_at, 'mode','manual','source','cash','idempotency_key',p_key,'created_by','tester'),
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

-- Move-out payload whose final invoice bills p_lf late fees (charges.lateFeeItems) and lists them in late_fees.
-- Since the late-fee-at-move-out feature every unbilled late fee must be billed or voided in the payload.
CREATE OR REPLACE FUNCTION pg_temp.payload_lf(tenant uuid, room uuid, k text, settlement jsonb, debts jsonb, p_lf numeric,
                                              discount numeric, billed jsonb)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('tenant_id', tenant, 'room_id', room, 'idempotency_key', k, 'move_out_date', '2026-09-28',
    'created_by', 'tester', 'paid_at', '2026-09-28T10:00:00+07:00', 'source', 'credit', 'settlement', settlement, 'debts', debts,
    'late_fees', jsonb_build_object('billed', billed, 'voided', '[]'::jsonb),
    'invoice', jsonb_build_object('id', gen_random_uuid(), 'start_date', '2026-09-25', 'end_date', '2026-09-28',
      'issue_date', '2026-09-28', 'due_date', '2026-10-05', 'rent_amount', 0, 'water_bill', 0, 'electricity_bill', 0,
      'common_fee', 0, 'late_fee_amount', p_lf, 'additional_fees_total', p_lf, 'carry_forward_amount', 0,
      'discount_amount', discount, 'total_amount', p_lf - discount,
      'additional_fees_breakdown', jsonb_build_array(jsonb_build_object('item_type','late_fee_line','label','late fees','amount',p_lf)),
      'notes', 'test'),
    'charges', jsonb_build_object('rent', 0, 'water', 0, 'electricity', 0, 'commonFee', 0, 'nativeLateFee', 0,
      'lateFeeItems', p_lf, 'fees', 0, 'carryForward', 0, 'discount', discount))
$f$;

DO $t$
DECLARE
  v_out text := '';
  v_room uuid; v_ta uuid; v_due date := current_date + 30;
  v_apr uuid; v_may uuid; v_res jsonb; v_bid uuid; v_msg text; v_n int;
  v_a uuid; v_b uuid; v_t uuid; v_r text; v_got numeric;
BEGIN
  ---------------------------------------------------------------- P1-P9 parity with the TypeScript fixtures
  FOR v_n, v_msg, v_got IN
    SELECT i, name, got FROM (VALUES
      (1, 'P1 a frozen amount always wins',          public.money_late_fee_amount('2026-06-06', 50, 0, 120, '2026-07-30'), 120),
      (2, 'P2 no start date',                         public.money_late_fee_amount(NULL, 50, 0, NULL, '2026-06-10'), 0),
      (3, 'P3 zero daily rate',                       public.money_late_fee_amount('2026-06-06', 0, 0, NULL, '2026-06-10'), 0),
      (4, 'P4 paid before the fee starts',            public.money_late_fee_amount('2026-06-06', 50, 0, NULL, '2026-06-05'), 0),
      (5, 'P5 start day counts (one day)',            public.money_late_fee_amount('2026-06-06', 50, 0, NULL, '2026-06-06'), 50),
      (6, 'P6 inclusive day count (5 days)',          public.money_late_fee_amount('2026-06-06', 50, 0, NULL, '2026-06-10'), 250),
      (7, 'P7 waived amount is subtracted',           public.money_late_fee_amount('2026-06-06', 50, 100, NULL, '2026-06-08'), 50),
      (8, 'P8 waived more than the fee floors at 0',  public.money_late_fee_amount('2026-06-06', 50, 999, NULL, '2026-06-08'), 0),
      (9, 'P9 fractional daily rate',                 public.money_late_fee_amount('2026-06-06', 12.5, 0, NULL, '2026-06-09'), 50)
    ) q(i, name, got, expected) WHERE got IS DISTINCT FROM expected
  LOOP
    v_out := v_out || E'\n' || 'FAIL  ' || v_msg || ' got ' || v_got;
  END LOOP;
  IF v_out = '' THEN v_out := E'\n' || 'PASS  P1-P9 money_late_fee_amount returns exactly the TypeScript parity fixtures (9/9)'; END IF;

  INSERT INTO rooms(room_number) VALUES ('T-'||gen_random_uuid()) RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id) VALUES ('Freeze A', current_date, v_room) RETURNING id INTO v_ta;

  ---------------------------------------------------------------- U1 paying a source freezes the target's fee as of the PAYMENT date
  v_apr := pg_temp.ni(v_ta, v_room, 1400, 0, 0, 'pending', v_due, NULL, NULL);
  v_may := pg_temp.ni(v_ta, v_room, 7594, 1400, 6194, 'partial', v_due, '2026-06-06', 50);   -- own share paid, April open, no frozen fee
  INSERT INTO invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_apr, v_may, 1400);
  v_res := pg_temp.pay(v_ta, v_apr, 1400, 'u1', '2026-06-10T12:00:00+07:00');
  v_bid := (v_res->>'batch_id')::uuid;
  SELECT count(*) INTO v_n FROM money_events WHERE invoice_id = v_may AND action = 'invoice.status_rederive'
     AND payment_batch_id = v_bid AND (after->>'locked_late_fee_amount')::numeric = 250 AND before->'locked_late_fee_amount' = 'null'::jsonb;
  v_out := v_out || E'\n' || CASE WHEN pg_temp.st(v_may) = '6194.00/paid/250.00' AND v_n = 1
    THEN 'PASS  U1 May settles via April and freezes 250 = 5 days (6-10 June) x 50 as of the payment date; paid_amount untouched; event records before NULL / after 250'
    ELSE 'FAIL  U1 May='||pg_temp.st(v_may)||' events='||v_n END;

  ---------------------------------------------------------------- U3 void the source: target reopens and unfreezes
  v_res := void_payment_batch(v_bid, 'wrong slip', 'tester');
  v_out := v_out || E'\n' || CASE WHEN pg_temp.st(v_may) = '6194.00/partial/NULL'
    THEN 'PASS  U3 voiding April reopens May and clears the frozen fee ('||pg_temp.st(v_may)||')'
    ELSE 'FAIL  U3 '||pg_temp.st(v_may) END;

  ---------------------------------------------------------------- U2 an already-frozen fee is never overwritten
  v_apr := pg_temp.ni(v_ta, v_room, 1400, 0, 0, 'pending', v_due, NULL, NULL);
  v_may := pg_temp.ni(v_ta, v_room, 7594, 1400, 6194, 'partial', v_due, '2026-06-06', 50);
  UPDATE invoices SET locked_late_fee_amount = 999 WHERE id = v_may;
  INSERT INTO invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_apr, v_may, 1400);
  PERFORM pg_temp.pay(v_ta, v_apr, 1400, 'u2', '2026-06-10T12:00:00+07:00');
  v_out := v_out || E'\n' || CASE WHEN pg_temp.st(v_may) = '6194.00/paid/999.00'
    THEN 'PASS  U2 a fee that was already frozen (999) is kept, not recomputed ('||pg_temp.st(v_may)||')'
    ELSE 'FAIL  U2 '||pg_temp.st(v_may) END;

  ---------------------------------------------------------------- U4 move-out credit: the invoice it pays AND its downstream target freeze
  INSERT INTO rooms(room_number, status) VALUES ('T-'||gen_random_uuid(), 'occupied') RETURNING id INTO v_room;
  INSERT INTO tenants(full_name, move_in_date, room_id, status, security_deposit_amount, advance_rent_amount)
    VALUES ('Freeze Settle', '2026-01-01', v_room, 'active', 3000, 0) RETURNING id INTO v_t;
  v_a := pg_temp.ni(v_t, v_room, 1000, 0, 0, 'overdue', '2026-09-05', '2026-09-06', 10);
  v_b := pg_temp.ni(v_t, v_room, 2500, 1000, 1500, 'partial', '2026-09-05', '2026-09-06', 20);
  INSERT INTO invoice_carry_forwards(source_invoice_id, target_invoice_id, amount) VALUES (v_a, v_b, 1000);
  -- The 230 + 460 late fees are billed on the final invoice (690), paid from the 3,000 deposit together with A's 1,000 debt.
  v_r := pg_temp.try_settle(pg_temp.payload_lf(v_t, v_room, 'k-u4',
           pg_temp.plan(0,0,0, 3000,0,1690,1310, 690,690,1310,
             jsonb_build_array(jsonb_build_object('invoiceId', v_a, 'periodStart','2026-08-25','outstandingBefore',1000,'paidFromCredit',1000,'outstandingAfter',0))),
           jsonb_build_array(jsonb_build_object('invoice_id', v_a, 'expected_paid_amount', 0)), 690, 690,
           jsonb_build_array(jsonb_build_object('invoice_id', v_a, 'amount', 230), jsonb_build_object('invoice_id', v_b, 'amount', 460))));
  -- 6 Sep .. 28 Sep inclusive = 23 days: A 23 x 10 = 230, B 23 x 20 = 460 (billed on the final invoice, which freezes them)
  v_out := v_out || E'\n' || CASE WHEN v_r LIKE 'OK:%' AND pg_temp.st(v_a) = '1000.00/paid/230.00' AND pg_temp.st(v_b) = '1500.00/paid/460.00'
    THEN 'PASS  U4 settlement credit freezes the paid older invoice (230) and its downstream target (460) as of the settlement date 28 Sep ('||pg_temp.st(v_a)||', '||pg_temp.st(v_b)||')'
    ELSE 'FAIL  U4 '||left(v_r,160)||' A='||pg_temp.st(v_a)||' B='||pg_temp.st(v_b) END;

  RAISE EXCEPTION 'RESULT:%', v_out;
END
$t$;
