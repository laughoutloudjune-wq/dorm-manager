-- Late-fee approval, posting, waiver and waiver reversal (Phase 4)
--
-- ADDITIVE ONLY. New functions plus two nullable columns on late_fee_policies.
-- No existing row is changed. NOT applied automatically: run it deliberately.
-- Requires 20261002000000 (money_events), 20261002000100 (adjustments),
-- 20261002000400 (late_fee_charges, late_fee_policies).
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.post_late_fee_charge(jsonb);
--   DROP FUNCTION IF EXISTS public.waive_late_fee(jsonb);
--   DROP FUNCTION IF EXISTS public.reverse_late_fee_waiver(jsonb);
--   DROP FUNCTION IF EXISTS public.create_late_fee_policy(jsonb);
--   DROP FUNCTION IF EXISTS public.late_fee_engine_check(jsonb, public.invoices, jsonb);
--   ALTER TABLE public.late_fee_policies DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS note;
--
-- Division of labour: the application calculates (the estimate in
-- lib/money/late-fee.ts, the recomputed money columns in lib/invoice-total.ts);
-- these functions WRITE it, all or nothing, with the target invoice row locked.
-- They do not trust the caller: the supplied columns must equal the locked row
-- plus/minus exactly the fee, and must satisfy the totals-engine identity
--   total = rent + water + electricity + common_fee
--         + late_fee_amount + additional_fees_total - late_fee_lines
--         + carry_forward_amount - discount_amount
-- (late_fee_amount and additional_fees_total both contain the late-fee lines;
-- see chargesFromInvoiceRow). A stale screen can never overwrite a newer invoice.
--
-- Waivers are rows in `adjustments` (type 'waiver', positive amount), tagged
-- source = 'late_fee_charge:<charge id>'. A reversal is a paired 'reversal' row
-- (negative amount, reverses_adjustment_id). Net waived for a charge is the sum
-- of its adjustments; nothing is ever deleted or edited in place, except the
-- invoice's own late-fee line, which mirrors the ledger (original_amount stays,
-- waived_amount / total_amount follow the adjustments).
--
-- Automation: a poster named 'automation:<name>' is accepted only when the
-- referenced policy has auto_post = true, and only for source invoices that
-- fell due on/after the day that policy was created (a new policy is never
-- applied to historical invoices automatically). Default auto_post is false.

ALTER TABLE public.late_fee_policies ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE public.late_fee_policies ADD COLUMN IF NOT EXISTS note TEXT;

-- Raises unless the proposed columns satisfy the totals-engine identity, given
-- the breakdown they will be stored with.
CREATE OR REPLACE FUNCTION public.late_fee_engine_check(cols jsonb, r public.invoices, breakdown jsonb)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_lines numeric;
    v_engine numeric;
BEGIN
    SELECT COALESCE(SUM(COALESCE((e->>'total_amount')::numeric, (e->>'amount')::numeric, 0)), 0)
      INTO v_lines
      FROM jsonb_array_elements(COALESCE(breakdown, '[]'::jsonb)) AS e
     WHERE lower(COALESCE(e->>'item_type', e->>'type', '')) = 'late_fee_line';

    IF (cols->>'late_fee_amount')::numeric < v_lines
       OR (cols->>'additional_fees_total')::numeric < v_lines THEN
        RAISE EXCEPTION 'ENGINE_MISMATCH late-fee columns are smaller than the late-fee lines (%)', v_lines;
    END IF;

    v_engine := COALESCE(r.rent_amount, 0) + COALESCE(r.water_bill, 0)
              + COALESCE(r.electricity_bill, 0) + COALESCE(r.common_fee, 0)
              + (cols->>'late_fee_amount')::numeric
              + (cols->>'additional_fees_total')::numeric - v_lines
              + (cols->>'carry_forward_amount')::numeric
              - (cols->>'discount_amount')::numeric;
    IF v_engine <> (cols->>'total_amount')::numeric THEN
        RAISE EXCEPTION 'ENGINE_MISMATCH total_amount % but the totals engine gives %',
            (cols->>'total_amount')::numeric, v_engine;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- post_late_fee_charge(p)
--   { "charge": {source_invoice_id, target_invoice_id, covered_from, covered_to,
--                eligible_balance, rate_kind, rate_value, formula, policy_version,
--                amount, posted_by},
--     "target": {expected_total_amount,
--                columns: {total_amount, late_fee_amount, additional_fees_total,
--                          carry_forward_amount, discount_amount}} }
-- Returns {replayed, charge_id, amount, target_invoice_id, total_amount}.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_late_fee_charge(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    c jsonb := p->'charge';
    cols jsonb := p->'target'->'columns';
    v_source uuid := NULLIF(c->>'source_invoice_id', '')::uuid;
    v_target uuid := NULLIF(c->>'target_invoice_id', '')::uuid;
    v_from date := NULLIF(c->>'covered_from', '')::date;
    v_to date := NULLIF(c->>'covered_to', '')::date;
    v_version integer := NULLIF(c->>'policy_version', '')::integer;
    v_amount numeric := NULLIF(c->>'amount', '')::numeric;
    v_eligible numeric := COALESCE(NULLIF(c->>'eligible_balance', '')::numeric, 0);
    v_rate_kind text := NULLIF(btrim(COALESCE(c->>'rate_kind', ''), E' \t\r\n'), '');
    v_rate_value numeric := NULLIF(c->>'rate_value', '')::numeric;
    v_formula text := NULLIF(btrim(COALESCE(c->>'formula', ''), E' \t\r\n'), '');
    v_by text := NULLIF(btrim(COALESCE(c->>'posted_by', ''), E' \t\r\n'), '');
    v_expected numeric := NULLIF(p->'target'->>'expected_total_amount', '')::numeric;
    v_policy public.late_fee_policies%ROWTYPE;
    v_existing public.late_fee_charges%ROWTYPE;
    v_src public.invoices%ROWTYPE;
    v_row public.invoices%ROWTYPE;
    v_charge_id uuid := gen_random_uuid();
    v_days integer;
    v_posted_same_policy numeric;
    v_breakdown jsonb;
BEGIN
    IF v_amount IS NULL OR v_amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT amount must be greater than 0';
    END IF;
    IF v_amount <> round(v_amount, 2) THEN
        RAISE EXCEPTION 'INVALID_AMOUNT amount % has more than 2 decimals', v_amount;
    END IF;
    IF v_source IS NULL OR v_target IS NULL OR v_source = v_target THEN
        RAISE EXCEPTION 'INVALID_INVOICES source and target must be two different invoices';
    END IF;
    IF v_from IS NULL OR v_to IS NULL OR v_to < v_from THEN
        RAISE EXCEPTION 'INVALID_PERIOD covered_from/covered_to are required and ordered';
    END IF;
    IF v_by IS NULL THEN
        RAISE EXCEPTION 'POSTED_BY_REQUIRED posted_by is required';
    END IF;
    IF v_formula IS NULL OR v_rate_kind IS NULL OR v_rate_value IS NULL THEN
        RAISE EXCEPTION 'FORMULA_REQUIRED formula, rate_kind and rate_value are required';
    END IF;
    IF v_expected IS NULL OR cols IS NULL THEN
        RAISE EXCEPTION 'TARGET_REQUIRED target.expected_total_amount and target.columns are required';
    END IF;

    SELECT * INTO v_policy FROM public.late_fee_policies WHERE version = v_version;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'UNKNOWN_POLICY_VERSION %', v_version;
    END IF;

    -- Lock the target first: concurrent posts/waivers on it serialise here.
    SELECT * INTO v_row FROM public.invoices WHERE id = v_target FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'INVOICE_NOT_FOUND target %', v_target;
    END IF;

    -- Exact duplicate key: replay the original instead of charging twice. The
    -- same key with different content is not a retry and is refused.
    SELECT * INTO v_existing FROM public.late_fee_charges
     WHERE source_invoice_id = v_source AND covered_from = v_from
       AND covered_to = v_to AND policy_version = v_version;
    IF FOUND THEN
        IF v_existing.amount <> v_amount OR v_existing.target_invoice_id IS DISTINCT FROM v_target THEN
            RAISE EXCEPTION 'DUPLICATE_CHARGE_DIFFERENT a charge for this source/period/policy already exists with amount % on invoice %',
                v_existing.amount, v_existing.target_invoice_id;
        END IF;
        RETURN jsonb_build_object('replayed', true, 'charge_id', v_existing.id,
                                  'amount', v_existing.amount,
                                  'target_invoice_id', v_existing.target_invoice_id,
                                  'total_amount', v_row.total_amount);
    END IF;

    -- A different period overlapping already-charged days of the same source.
    IF EXISTS (SELECT 1 FROM public.late_fee_charges
                WHERE source_invoice_id = v_source
                  AND covered_from <= v_to AND covered_to >= v_from) THEN
        RAISE EXCEPTION 'OVERLAPPING_CHARGE source % already has a charge overlapping % to %',
            v_source, v_from, v_to;
    END IF;

    SELECT * INTO v_src FROM public.invoices WHERE id = v_source;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'INVOICE_NOT_FOUND source %', v_source;
    END IF;
    IF v_src.tenant_id IS DISTINCT FROM v_row.tenant_id THEN
        RAISE EXCEPTION 'TENANT_MISMATCH source and target belong to different tenants';
    END IF;
    IF v_src.status::text IN ('draft', 'cancelled') THEN
        RAISE EXCEPTION 'SOURCE_NOT_BILLABLE source invoice is %', v_src.status;
    END IF;
    IF v_src.start_date IS NOT NULL AND v_row.start_date IS NOT NULL
       AND v_row.start_date <= v_src.start_date THEN
        RAISE EXCEPTION 'TARGET_NOT_LATER a late fee is billed on a later invoice than its source';
    END IF;
    IF v_src.due_date IS NULL OR v_from <= v_src.due_date THEN
        RAISE EXCEPTION 'PERIOD_BEFORE_DUE covered_from % must be after the source due date %', v_from, v_src.due_date;
    END IF;
    IF v_src.due_date < v_policy.effective_from THEN
        RAISE EXCEPTION 'POLICY_NOT_EFFECTIVE policy % starts % but the source fell due %',
            v_version, v_policy.effective_from, v_src.due_date;
    END IF;

    -- Automation identity and opt-in.
    IF v_by LIKE 'automation:%' THEN
        IF NOT v_policy.auto_post THEN
            RAISE EXCEPTION 'AUTO_POST_DISABLED policy % does not allow automatic posting', v_version;
        END IF;
        IF v_src.due_date < (v_policy.created_at AT TIME ZONE 'Asia/Bangkok')::date THEN
            RAISE EXCEPTION 'AUTO_POST_HISTORICAL invoice fell due before policy % existed; needs admin approval', v_version;
        END IF;
    END IF;

    -- Plausibility against the policy row (the caller computed the estimate).
    IF v_rate_kind <> v_policy.rate_kind OR v_rate_value <> v_policy.rate_value THEN
        RAISE EXCEPTION 'RATE_MISMATCH charge rate %/% differs from policy % (%/%)',
            v_rate_kind, v_rate_value, v_version, v_policy.rate_kind, v_policy.rate_value;
    END IF;
    v_days := (v_to - v_from) + 1;
    IF v_policy.rate_kind = 'flat_per_day' AND v_amount > v_days * v_policy.rate_value THEN
        RAISE EXCEPTION 'AMOUNT_EXCEEDS_RATE % for % days at % per day', v_amount, v_days, v_policy.rate_value;
    END IF;
    IF v_policy.rate_kind = 'flat_once' AND v_amount > v_policy.rate_value THEN
        RAISE EXCEPTION 'AMOUNT_EXCEEDS_RATE % exceeds the one-off fee %', v_amount, v_policy.rate_value;
    END IF;
    IF v_policy.rate_kind = 'percent_once' AND v_amount > ceil(v_eligible * v_policy.rate_value / 100) THEN
        RAISE EXCEPTION 'AMOUNT_EXCEEDS_RATE % exceeds % percent of %', v_amount, v_policy.rate_value, v_eligible;
    END IF;
    IF v_policy.rate_kind = 'percent_per_day' AND NOT v_policy.compounding
       AND v_amount > ceil(v_days * v_eligible * v_policy.rate_value / 100) THEN
        RAISE EXCEPTION 'AMOUNT_EXCEEDS_RATE % exceeds % days x % percent of %', v_amount, v_days, v_policy.rate_value, v_eligible;
    END IF;
    IF v_policy.cap IS NOT NULL THEN
        SELECT COALESCE(SUM(amount), 0) INTO v_posted_same_policy
          FROM public.late_fee_charges
         WHERE source_invoice_id = v_source AND policy_version = v_version;
        IF v_posted_same_policy + v_amount > v_policy.cap THEN
            RAISE EXCEPTION 'CAP_EXCEEDED % already posted + % exceeds the cap %', v_posted_same_policy, v_amount, v_policy.cap;
        END IF;
    END IF;

    -- Target must be open and unchanged since the caller read it.
    IF v_row.status::text IN ('paid', 'cancelled', 'verifying') THEN
        RAISE EXCEPTION 'TARGET_NOT_OPEN invoice % is %', v_target, v_row.status;
    END IF;
    IF COALESCE(v_row.total_amount, 0) <> v_expected THEN
        RAISE EXCEPTION 'STALE_INVOICE % (expected total %, actual %)', v_target, v_expected, v_row.total_amount;
    END IF;
    IF (cols->>'total_amount')::numeric <> COALESCE(v_row.total_amount, 0) + v_amount
       OR (cols->>'late_fee_amount')::numeric <> COALESCE(v_row.late_fee_amount, 0) + v_amount
       OR (cols->>'additional_fees_total')::numeric <> COALESCE(v_row.additional_fees_total, 0) + v_amount
       OR (cols->>'carry_forward_amount')::numeric <> COALESCE(v_row.carry_forward_amount, 0)
       OR (cols->>'discount_amount')::numeric <> COALESCE(v_row.discount_amount, 0) THEN
        RAISE EXCEPTION 'INCONSISTENT_COLUMNS recomputed columns are not the current invoice plus the fee';
    END IF;

    -- A DISTINCT line, never merged into general fees, linked to its source and charge.
    v_breakdown := COALESCE(v_row.additional_fees_breakdown, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'item_type', 'late_fee_line',
        'source_invoice_id', v_source,
        'late_fee_charge_id', v_charge_id,
        'policy_version', v_version,
        'label', v_formula,
        'detail', v_formula,
        'covered_from', v_from,
        'covered_to', v_to,
        'days_overdue', v_days,
        'total_amount', v_amount,
        'amount', v_amount,
        'original_amount', v_amount,
        'waived_amount', 0,
        'posted_by', v_by));
    PERFORM public.late_fee_engine_check(cols, v_row, v_breakdown);

    INSERT INTO public.late_fee_charges (
        id, source_invoice_id, target_invoice_id, covered_from, covered_to,
        eligible_balance, rate_kind, rate_value, formula, policy_version, amount, posted_by
    ) VALUES (
        v_charge_id, v_source, v_target, v_from, v_to,
        v_eligible, v_rate_kind, v_rate_value, v_formula, v_version, v_amount, v_by
    );

    UPDATE public.invoices SET
        total_amount = (cols->>'total_amount')::numeric,
        late_fee_amount = (cols->>'late_fee_amount')::numeric,
        additional_fees_total = (cols->>'additional_fees_total')::numeric,
        additional_fees_breakdown = v_breakdown
    WHERE id = v_row.id;

    INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, room_id, before, after, reason, source)
    VALUES ('late_fee.post', v_by, v_row.tenant_id, v_target, v_row.room_id,
            jsonb_build_object('total_amount', v_row.total_amount, 'late_fee_amount', v_row.late_fee_amount,
                               'additional_fees_total', v_row.additional_fees_total),
            jsonb_build_object('charge_id', v_charge_id, 'source_invoice_id', v_source,
                               'amount', v_amount, 'policy_version', v_version,
                               'covered_from', v_from, 'covered_to', v_to, 'formula', v_formula,
                               'total_amount', (cols->>'total_amount')::numeric,
                               'automated', v_by LIKE 'automation:%'),
            NULL, 'late_fee_flow');

    RETURN jsonb_build_object('replayed', false, 'charge_id', v_charge_id, 'amount', v_amount,
                              'target_invoice_id', v_target,
                              'total_amount', (cols->>'total_amount')::numeric);
END;
$$;

COMMENT ON FUNCTION public.post_late_fee_charge(jsonb) IS
    'Atomically posts one approved late fee as a distinct late_fee_line on a later invoice: unique per source/period/policy (replays), overlap guard, locked target with expected-total + engine check, automation only under an auto_post policy, money_events audit.';

-- ---------------------------------------------------------------------------
-- waive_late_fee(p)
--   { "waiver": {charge_id, amount, reason, approver, idempotency_key},
--     "target": {expected_total_amount, columns: {...}} }
-- Returns {replayed, adjustment_id, amount, total_amount}.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.waive_late_fee(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    w jsonb := p->'waiver';
    cols jsonb := p->'target'->'columns';
    v_charge_id uuid := NULLIF(w->>'charge_id', '')::uuid;
    v_amount numeric := NULLIF(w->>'amount', '')::numeric;
    v_reason text := NULLIF(btrim(COALESCE(w->>'reason', ''), E' \t\r\n'), '');
    v_approver text := NULLIF(btrim(COALESCE(w->>'approver', ''), E' \t\r\n'), '');
    v_key text := NULLIF(btrim(COALESCE(w->>'idempotency_key', ''), E' \t\r\n'), '');
    v_expected numeric := NULLIF(p->'target'->>'expected_total_amount', '')::numeric;
    v_ref text;
    v_existing public.adjustments%ROWTYPE;
    v_adj_id uuid;
    v_charge public.late_fee_charges%ROWTYPE;
    v_row public.invoices%ROWTYPE;
    v_line jsonb;
    v_net_waived numeric;
    v_breakdown jsonb;
BEGIN
    IF v_reason IS NULL THEN
        RAISE EXCEPTION 'REASON_REQUIRED a reason is required to waive a late fee';
    END IF;
    IF v_approver IS NULL THEN
        RAISE EXCEPTION 'APPROVER_REQUIRED an approver is required to waive a late fee';
    END IF;
    IF v_key IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
    END IF;
    IF v_amount IS NULL OR v_amount <= 0 OR v_amount <> round(v_amount, 2) THEN
        RAISE EXCEPTION 'INVALID_AMOUNT waiver amount must be > 0 with at most 2 decimals';
    END IF;
    IF v_expected IS NULL OR cols IS NULL THEN
        RAISE EXCEPTION 'TARGET_REQUIRED target.expected_total_amount and target.columns are required';
    END IF;

    SELECT * INTO v_charge FROM public.late_fee_charges WHERE id = v_charge_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'CHARGE_NOT_FOUND %', v_charge_id;
    END IF;
    IF v_charge.target_invoice_id IS NULL THEN
        RAISE EXCEPTION 'CHARGE_NOT_BILLED charge % has no target invoice', v_charge_id;
    END IF;

    SELECT * INTO v_row FROM public.invoices WHERE id = v_charge.target_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'INVOICE_NOT_FOUND %', v_charge.target_invoice_id;
    END IF;

    v_ref := 'late_fee_waiver:' || v_charge_id::text || ':' || v_key;
    SELECT * INTO v_existing FROM public.adjustments WHERE reference_key = v_ref;
    IF FOUND THEN
        IF v_existing.amount <> v_amount THEN
            RAISE EXCEPTION 'DUPLICATE_KEY_DIFFERENT key already used for a waiver of %', v_existing.amount;
        END IF;
        RETURN jsonb_build_object('replayed', true, 'adjustment_id', v_existing.id,
                                  'amount', v_existing.amount, 'total_amount', v_row.total_amount);
    END IF;

    IF v_row.status::text = 'cancelled' THEN
        RAISE EXCEPTION 'TARGET_NOT_OPEN invoice % is cancelled', v_row.id;
    END IF;
    IF COALESCE(v_row.total_amount, 0) <> v_expected THEN
        RAISE EXCEPTION 'STALE_INVOICE % (expected total %, actual %)', v_row.id, v_expected, v_row.total_amount;
    END IF;

    -- The adjustments ledger is authoritative for how much is already waived.
    SELECT COALESCE(SUM(amount), 0) INTO v_net_waived
      FROM public.adjustments WHERE source = 'late_fee_charge:' || v_charge_id::text;
    IF v_amount > v_charge.amount - v_net_waived THEN
        RAISE EXCEPTION 'WAIVER_EXCEEDS_FEE waiving % but only % of % is still charged',
            v_amount, v_charge.amount - v_net_waived, v_charge.amount;
    END IF;

    SELECT e INTO v_line
      FROM jsonb_array_elements(COALESCE(v_row.additional_fees_breakdown, '[]'::jsonb)) AS e
     WHERE e->>'late_fee_charge_id' = v_charge_id::text
     LIMIT 1;
    IF v_line IS NULL THEN
        RAISE EXCEPTION 'LINE_NOT_FOUND charge % has no line on invoice %', v_charge_id, v_row.id;
    END IF;
    IF COALESCE((v_line->>'total_amount')::numeric, 0) <> v_charge.amount - v_net_waived THEN
        RAISE EXCEPTION 'LINE_OUT_OF_SYNC the invoice line shows % but the ledger says %',
            v_line->>'total_amount', v_charge.amount - v_net_waived;
    END IF;

    IF (cols->>'total_amount')::numeric <> COALESCE(v_row.total_amount, 0) - v_amount
       OR (cols->>'late_fee_amount')::numeric <> COALESCE(v_row.late_fee_amount, 0) - v_amount
       OR (cols->>'additional_fees_total')::numeric <> COALESCE(v_row.additional_fees_total, 0) - v_amount
       OR (cols->>'carry_forward_amount')::numeric <> COALESCE(v_row.carry_forward_amount, 0)
       OR (cols->>'discount_amount')::numeric <> COALESCE(v_row.discount_amount, 0) THEN
        RAISE EXCEPTION 'INCONSISTENT_COLUMNS recomputed columns are not the current invoice minus the waiver';
    END IF;
    IF (cols->>'total_amount')::numeric < COALESCE(v_row.paid_amount, 0) THEN
        RAISE EXCEPTION 'WAIVER_BELOW_PAID waiver would leave the total below the % already paid', v_row.paid_amount;
    END IF;

    SELECT jsonb_agg(
             CASE WHEN e.elem->>'late_fee_charge_id' = v_charge_id::text THEN
               e.elem || jsonb_build_object(
                 'original_amount', v_charge.amount,
                 'waived_amount', v_net_waived + v_amount,
                 'total_amount', v_charge.amount - (v_net_waived + v_amount),
                 'amount', v_charge.amount - (v_net_waived + v_amount))
             ELSE e.elem END
             ORDER BY e.ord)
      INTO v_breakdown
      FROM jsonb_array_elements(v_row.additional_fees_breakdown) WITH ORDINALITY AS e(elem, ord);
    PERFORM public.late_fee_engine_check(cols, v_row, v_breakdown);

    INSERT INTO public.adjustments (type, amount, invoice_id, tenant_id, reason, actor, source, reference_key)
    VALUES ('waiver', v_amount, v_row.id, v_row.tenant_id, v_reason, v_approver,
            'late_fee_charge:' || v_charge_id::text, v_ref)
    RETURNING id INTO v_adj_id;

    UPDATE public.invoices SET
        total_amount = (cols->>'total_amount')::numeric,
        late_fee_amount = (cols->>'late_fee_amount')::numeric,
        additional_fees_total = (cols->>'additional_fees_total')::numeric,
        additional_fees_breakdown = v_breakdown
    WHERE id = v_row.id;

    INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, room_id, before, after, reason, source)
    VALUES ('late_fee.waive', v_approver, v_row.tenant_id, v_row.id, v_row.room_id,
            jsonb_build_object('total_amount', v_row.total_amount, 'waived_amount', v_net_waived),
            jsonb_build_object('charge_id', v_charge_id, 'adjustment_id', v_adj_id, 'amount', v_amount,
                               'waived_amount', v_net_waived + v_amount,
                               'total_amount', (cols->>'total_amount')::numeric),
            v_reason, 'late_fee_flow');

    RETURN jsonb_build_object('replayed', false, 'adjustment_id', v_adj_id, 'amount', v_amount,
                              'total_amount', (cols->>'total_amount')::numeric);
END;
$$;

COMMENT ON FUNCTION public.waive_late_fee(jsonb) IS
    'Atomically waives part or all of one posted late fee: append-only adjustments row (reason + approver required, never above what is still charged), invoice line and columns re-derived and checked. Idempotent per key.';

-- ---------------------------------------------------------------------------
-- reverse_late_fee_waiver(p)
--   { "reversal": {adjustment_id, reason, approver},
--     "target": {expected_total_amount, columns: {...}} }
-- Returns {replayed, adjustment_id, amount, total_amount}.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_late_fee_waiver(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    r jsonb := p->'reversal';
    cols jsonb := p->'target'->'columns';
    v_adj_id uuid := NULLIF(r->>'adjustment_id', '')::uuid;
    v_reason text := NULLIF(btrim(COALESCE(r->>'reason', ''), E' \t\r\n'), '');
    v_approver text := NULLIF(btrim(COALESCE(r->>'approver', ''), E' \t\r\n'), '');
    v_expected numeric := NULLIF(p->'target'->>'expected_total_amount', '')::numeric;
    v_waiver public.adjustments%ROWTYPE;
    v_existing public.adjustments%ROWTYPE;
    v_charge public.late_fee_charges%ROWTYPE;
    v_row public.invoices%ROWTYPE;
    v_net_waived numeric;
    v_new_id uuid;
    v_breakdown jsonb;
BEGIN
    IF v_reason IS NULL THEN
        RAISE EXCEPTION 'REASON_REQUIRED a reason is required to reverse a waiver';
    END IF;
    IF v_approver IS NULL THEN
        RAISE EXCEPTION 'APPROVER_REQUIRED an approver is required to reverse a waiver';
    END IF;
    IF v_expected IS NULL OR cols IS NULL THEN
        RAISE EXCEPTION 'TARGET_REQUIRED target.expected_total_amount and target.columns are required';
    END IF;

    SELECT * INTO v_waiver FROM public.adjustments WHERE id = v_adj_id;
    IF NOT FOUND OR v_waiver.type <> 'waiver' OR v_waiver.source NOT LIKE 'late_fee_charge:%' THEN
        RAISE EXCEPTION 'WAIVER_NOT_FOUND % is not a late-fee waiver', v_adj_id;
    END IF;
    SELECT * INTO v_charge FROM public.late_fee_charges
     WHERE id = substring(v_waiver.source FROM length('late_fee_charge:') + 1)::uuid;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'CHARGE_NOT_FOUND for waiver %', v_adj_id;
    END IF;

    SELECT * INTO v_row FROM public.invoices WHERE id = v_charge.target_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'INVOICE_NOT_FOUND %', v_charge.target_invoice_id;
    END IF;

    SELECT * INTO v_existing FROM public.adjustments WHERE reverses_adjustment_id = v_adj_id;
    IF FOUND THEN
        RETURN jsonb_build_object('replayed', true, 'adjustment_id', v_existing.id,
                                  'amount', v_existing.amount, 'total_amount', v_row.total_amount);
    END IF;

    -- Reinstating a fee raises what the tenant owes: only on an open invoice.
    IF v_row.status::text IN ('paid', 'cancelled', 'verifying') THEN
        RAISE EXCEPTION 'TARGET_NOT_OPEN invoice % is %', v_row.id, v_row.status;
    END IF;
    IF COALESCE(v_row.total_amount, 0) <> v_expected THEN
        RAISE EXCEPTION 'STALE_INVOICE % (expected total %, actual %)', v_row.id, v_expected, v_row.total_amount;
    END IF;
    IF (cols->>'total_amount')::numeric <> COALESCE(v_row.total_amount, 0) + v_waiver.amount
       OR (cols->>'late_fee_amount')::numeric <> COALESCE(v_row.late_fee_amount, 0) + v_waiver.amount
       OR (cols->>'additional_fees_total')::numeric <> COALESCE(v_row.additional_fees_total, 0) + v_waiver.amount
       OR (cols->>'carry_forward_amount')::numeric <> COALESCE(v_row.carry_forward_amount, 0)
       OR (cols->>'discount_amount')::numeric <> COALESCE(v_row.discount_amount, 0) THEN
        RAISE EXCEPTION 'INCONSISTENT_COLUMNS recomputed columns are not the current invoice plus the reinstated fee';
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_net_waived
      FROM public.adjustments WHERE source = v_waiver.source;

    SELECT jsonb_agg(
             CASE WHEN e.elem->>'late_fee_charge_id' = v_charge.id::text THEN
               e.elem || jsonb_build_object(
                 'original_amount', v_charge.amount,
                 'waived_amount', v_net_waived - v_waiver.amount,
                 'total_amount', v_charge.amount - (v_net_waived - v_waiver.amount),
                 'amount', v_charge.amount - (v_net_waived - v_waiver.amount))
             ELSE e.elem END
             ORDER BY e.ord)
      INTO v_breakdown
      FROM jsonb_array_elements(COALESCE(v_row.additional_fees_breakdown, '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord);
    IF v_breakdown IS NULL OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_breakdown) e WHERE e->>'late_fee_charge_id' = v_charge.id::text) THEN
        RAISE EXCEPTION 'LINE_NOT_FOUND charge % has no line on invoice %', v_charge.id, v_row.id;
    END IF;
    PERFORM public.late_fee_engine_check(cols, v_row, v_breakdown);

    INSERT INTO public.adjustments (type, amount, invoice_id, tenant_id, reason, actor, source,
                                    reverses_adjustment_id, reference_key)
    VALUES ('reversal', -v_waiver.amount, v_row.id, v_row.tenant_id, v_reason, v_approver,
            v_waiver.source, v_adj_id, 'late_fee_waiver_reversal:' || v_adj_id::text)
    RETURNING id INTO v_new_id;

    UPDATE public.invoices SET
        total_amount = (cols->>'total_amount')::numeric,
        late_fee_amount = (cols->>'late_fee_amount')::numeric,
        additional_fees_total = (cols->>'additional_fees_total')::numeric,
        additional_fees_breakdown = v_breakdown
    WHERE id = v_row.id;

    INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, room_id, before, after, reason, source)
    VALUES ('late_fee.waiver_reversed', v_approver, v_row.tenant_id, v_row.id, v_row.room_id,
            jsonb_build_object('total_amount', v_row.total_amount, 'waived_amount', v_net_waived),
            jsonb_build_object('charge_id', v_charge.id, 'reversed_adjustment_id', v_adj_id,
                               'adjustment_id', v_new_id, 'amount', v_waiver.amount,
                               'waived_amount', v_net_waived - v_waiver.amount,
                               'total_amount', (cols->>'total_amount')::numeric),
            v_reason, 'late_fee_flow');

    RETURN jsonb_build_object('replayed', false, 'adjustment_id', v_new_id, 'amount', -v_waiver.amount,
                              'total_amount', (cols->>'total_amount')::numeric);
END;
$$;

COMMENT ON FUNCTION public.reverse_late_fee_waiver(jsonb) IS
    'Reverses one late-fee waiver with a paired reversal adjustment (never deletes); reinstates the fee on the locked, open target invoice with expected-total + engine check.';

-- ---------------------------------------------------------------------------
-- create_late_fee_policy(p): append a NEW policy version (never edits one).
--   {effective_from, grace_days, rate_kind, rate_value, partial_payments_reduce_base,
--    cap, rounding, compounding, auto_post, created_by, note}
-- Creating a policy never touches an invoice or a posted charge.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_late_fee_policy(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_by text := NULLIF(btrim(COALESCE(p->>'created_by', ''), E' \t\r\n'), '');
    v_version integer;
    v_id uuid;
BEGIN
    IF v_by IS NULL THEN
        RAISE EXCEPTION 'CREATED_BY_REQUIRED';
    END IF;
    -- Serialise version numbering.
    LOCK TABLE public.late_fee_policies IN SHARE ROW EXCLUSIVE MODE;
    SELECT COALESCE(MAX(version), 0) + 1 INTO v_version FROM public.late_fee_policies;

    INSERT INTO public.late_fee_policies (
        version, effective_from, grace_days, rate_kind, rate_value, partial_payments_reduce_base,
        cap, rounding, compounding, auto_post, created_by, note
    ) VALUES (
        v_version, (p->>'effective_from')::date, COALESCE((p->>'grace_days')::integer, 0),
        p->>'rate_kind', (p->>'rate_value')::numeric,
        COALESCE((p->>'partial_payments_reduce_base')::boolean, true),
        NULLIF(p->>'cap', '')::numeric, COALESCE(p->>'rounding', 'floor'),
        COALESCE((p->>'compounding')::boolean, false), COALESCE((p->>'auto_post')::boolean, false),
        v_by, NULLIF(btrim(COALESCE(p->>'note', ''), E' \t\r\n'), '')
    ) RETURNING id INTO v_id;

    INSERT INTO public.money_events (action, actor_user_id, before, after, reason, source)
    VALUES ('late_fee.policy_created', v_by, NULL, to_jsonb((SELECT x FROM public.late_fee_policies x WHERE x.id = v_id)),
            NULLIF(btrim(COALESCE(p->>'note', ''), E' \t\r\n'), ''), 'late_fee_flow');

    RETURN jsonb_build_object('id', v_id, 'version', v_version);
END;
$$;

COMMENT ON FUNCTION public.create_late_fee_policy(jsonb) IS
    'Appends a new late-fee policy version (next integer) with its author; never edits an older version and never touches invoices.';
