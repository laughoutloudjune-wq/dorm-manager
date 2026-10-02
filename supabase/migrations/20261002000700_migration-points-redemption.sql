-- Atomic points redemption + paired reversal
--
-- Requires: 20260730000000 (point_ledger_entries), 20261002000000 (money_events),
--           20261002000100 (adjustments).
-- NOT applied automatically. Apply BEFORE deploying the app code that calls these
-- functions (lib/points-ledger.ts redeemPoints / reverseRedemption).
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.redeem_points_atomic(jsonb);
--   DROP FUNCTION IF EXISTS public.reverse_points_redemption(jsonb);
--   The schema additions below are harmless to leave. To remove them, first make sure
--   no 'redemption_reversal' ledger rows / 'points_redemption' adjustments exist.
--
-- What this replaces (findings 20-25): redeemPoints wrote the invoice discount, then
-- the ledger row, and hand-reverted the invoice if the second write failed; balance
-- and monthly-limit checks were unlocked read-then-write; the idempotency key was
-- optional; the cap was total - paid (so late fees and carried debt were
-- discountable); deleteRedemption hard-deleted the ledger row, which returned the
-- points, LEFT the discount on the invoice and reset the monthly limit.
--
-- ONE business fact, TWO rows, ONE key:
--   point_ledger_entries.idempotency_key = adjustments.reference_key = <key>
--   (point side: reason 'redemption', negative points;
--    invoice side: adjustments.type 'points_redemption', positive baht)
-- A reversal is a NEW pair sharing '<key>:reversal':
--   point side: reason 'redemption_reversal', positive points, reverses_entry_id -> original
--   invoice side: adjustments.type 'reversal', negative baht, reverses_adjustment_id -> original
-- Nothing is ever deleted or updated on either side. Each redemption can be
-- reversed at most once (unique partial indexes on both sides).
--
-- Locking (same order in both functions, so they cannot deadlock each other):
--   1. the invoice row  FOR UPDATE
--   2. every point_ledger_entries row of the tenant, ORDER BY id, FOR UPDATE
-- Step 2 is the per-tenant mutex for balance and monthly-limit checks: a second
-- redemption for the same tenant (even on another invoice) waits until the first
-- commits, then re-reads the balance/count with a fresh snapshot (READ COMMITTED,
-- one snapshot per statement). A tenant with no point rows has balance 0 and is
-- rejected anyway, so the empty-set case cannot overdraw.
--
-- Amounts: the application computes the new invoice money columns through
-- lib/invoice-total.ts (computeInvoiceTotal / toInvoiceMoneyColumns) and passes
-- them. These functions never recompute a total; they check
--   * the invoice still holds every value the caller computed from (STALE_INVOICE), and
--   * new = expected -/+ the discount on total/discount, unchanged on every other column.
--
-- Discount cap (rechecked here on the locked row; the caller must already respect it):
--   baht <= max_redemption_baht
--   baht <= target charge - discount_amount
--            (target 'rent' -> rent_amount, 'utility' -> water_bill + electricity_bill)
--   baht <= rent + water + electricity - discount_amount - paid_amount
-- i.e. only rent/utilities are ever discountable. Late fees, common fee, other fees
-- and carried debt never are. paid_amount is assumed to have covered rent/utilities
-- first (the conservative reading: a partly paid invoice whose remainder is only a
-- late fee cannot be discounted).
--
-- MONTHLY LIMIT ACCOUNTING (precise definition):
--   used(tenant, month) = number of point_ledger_entries rows with reason = 'redemption'
--   for the tenant whose created_at falls in the current Asia/Bangkok calendar month.
--   A reversal ('redemption_reversal') is a separate row and does NOT decrement
--   used(): a reversed redemption still consumed that month's slot. Before this,
--   deleting the row silently handed the slot back; append-only rows cannot, and a
--   redeem -> reverse -> redeem loop can no longer bypass the limit. If the owner
--   wants a mistaken redemption to free the slot, that must be an explicit,
--   separately-audited override, not a side effect of the reversal.
--
-- Points vs baht: points_spent is a whole number; baht = points_spent / points_per_baht
-- rounded to 2 dp (checked to within 0.005). Points earned, points redeemed, baht
-- discount and cash received stay separate: a redemption never touches paid_amount,
-- payment_history, payment_batches or allocations.
--
-- Input, redeem_points_atomic(p):
--  { tenant_id, invoice_id, target ('rent'|'utility'), reference_key (required),
--    points_to_spend (int > 0), baht_applied, points_per_baht,
--    max_redemption_baht, max_redemptions_per_month,
--    expected: {total_amount, discount_amount, paid_amount, late_fee_amount,
--               additional_fees_total, carry_forward_amount, rent_amount,
--               water_bill, electricity_bill, common_fee},
--    new: {total_amount, discount_amount, late_fee_amount, additional_fees_total,
--          carry_forward_amount},
--    created_by (uuid, optional), actor (text, optional) }
-- Input, reverse_points_redemption(p):
--  { entry_id, reason (required), expected: {...same keys...}, new: {...same keys...},
--    created_by (uuid, optional), actor (text, optional) }

-- ---------------------------------------------------------------- schema

ALTER TABLE public.point_ledger_entries
    DROP CONSTRAINT IF EXISTS point_ledger_entries_reason_check;
ALTER TABLE public.point_ledger_entries
    ADD CONSTRAINT point_ledger_entries_reason_check CHECK (
        reason IN (
            'rent_on_time', 'streak_bonus', 'referral_bonus', 'milestone_3mo',
            'milestone_1yr', 'redemption', 'redemption_reversal', 'manual_adjustment'
        )
    );

ALTER TABLE public.point_ledger_entries
    ADD COLUMN IF NOT EXISTS reverses_entry_id UUID
        REFERENCES public.point_ledger_entries(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_point_ledger_single_reversal
    ON public.point_ledger_entries(reverses_entry_id)
    WHERE reverses_entry_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'point_ledger_reversal_link_check') THEN
        ALTER TABLE public.point_ledger_entries
            ADD CONSTRAINT point_ledger_reversal_link_check
            CHECK ((reason = 'redemption_reversal') = (reverses_entry_id IS NOT NULL));
    END IF;
END $$;

-- adjustments.type gains 'points_redemption'. Rebuilt from whatever values the CHECK
-- holds now, so types added by other migrations are kept.
DO $$
DECLARE
    v_def text;
    v_vals text[];
BEGIN
    SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
    WHERE conrelid = 'public.adjustments'::regclass AND conname = 'adjustments_type_check';
    IF v_def IS NOT NULL AND v_def !~ '\mpoints_redemption\M' THEN
        -- Two printed forms exist: ARRAY['a'::text, ...] and '{a,b}'::text[].
        IF v_def ~ '''\{' THEN
            v_vals := string_to_array(substring(v_def from '''\{([^}]*)\}'''), ',');
        ELSE
            SELECT array_agg(m[1]) INTO v_vals FROM regexp_matches(v_def, '''([a-z_]+)''', 'g') AS m;
        END IF;
        IF v_vals IS NULL OR cardinality(v_vals) = 0 THEN
            RAISE EXCEPTION 'Could not parse adjustments_type_check: %', v_def;
        END IF;
        v_vals := v_vals || ARRAY['points_redemption'];
        ALTER TABLE public.adjustments DROP CONSTRAINT adjustments_type_check;
        EXECUTE format(
            'ALTER TABLE public.adjustments ADD CONSTRAINT adjustments_type_check CHECK (type = ANY (%L::text[]))',
            v_vals);
    END IF;
END $$;

-- ---------------------------------------------------------------- shared helpers

-- Raises STALE_INVOICE unless every expected column equals the locked row.
CREATE OR REPLACE FUNCTION public.points_assert_invoice_unchanged(v_inv public.invoices, p_expected jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_key text;
    v_row jsonb := to_jsonb(v_inv);
    v_keys text[] := ARRAY['total_amount', 'discount_amount', 'paid_amount', 'late_fee_amount',
                           'additional_fees_total', 'carry_forward_amount', 'rent_amount',
                           'water_bill', 'electricity_bill', 'common_fee'];
BEGIN
    IF p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object' THEN
        RAISE EXCEPTION 'expected invoice columns are required.';
    END IF;
    FOREACH v_key IN ARRAY v_keys LOOP
        IF NOT (p_expected ? v_key) THEN
            RAISE EXCEPTION 'expected.% is required.', v_key;
        END IF;
        IF round(COALESCE((v_row->>v_key)::numeric, 0), 2)
           <> round(COALESCE((p_expected->>v_key)::numeric, 0), 2) THEN
            RAISE EXCEPTION 'STALE_INVOICE % (% is %, caller computed from %)',
                v_inv.id, v_key, COALESCE(v_row->>v_key, 'null'), p_expected->>v_key;
        END IF;
    END LOOP;
END;
$$;

-- Raises unless new = expected + p_discount_delta on discount, expected - delta on total,
-- and every other money column unchanged.
CREATE OR REPLACE FUNCTION public.points_assert_new_columns(p_expected jsonb, p_new jsonb, p_discount_delta numeric)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_key text;
BEGIN
    IF p_new IS NULL OR jsonb_typeof(p_new) <> 'object' THEN
        RAISE EXCEPTION 'new invoice columns are required.';
    END IF;
    FOREACH v_key IN ARRAY ARRAY['total_amount', 'discount_amount', 'late_fee_amount',
                                 'additional_fees_total', 'carry_forward_amount'] LOOP
        IF NOT (p_new ? v_key) OR (p_new->>v_key) IS NULL THEN
            RAISE EXCEPTION 'new.% is required.', v_key;
        END IF;
    END LOOP;
    IF round((p_new->>'discount_amount')::numeric, 2)
       <> round(COALESCE((p_expected->>'discount_amount')::numeric, 0) + p_discount_delta, 2)
       OR round((p_new->>'total_amount')::numeric, 2)
       <> round(COALESCE((p_expected->>'total_amount')::numeric, 0) - p_discount_delta, 2) THEN
        RAISE EXCEPTION 'INCONSISTENT_COLUMNS: new total/discount must equal expected -/+ % (got total %, discount %)',
            p_discount_delta, p_new->>'total_amount', p_new->>'discount_amount';
    END IF;
    FOREACH v_key IN ARRAY ARRAY['late_fee_amount', 'additional_fees_total', 'carry_forward_amount'] LOOP
        IF round((p_new->>v_key)::numeric, 2) <> round(COALESCE((p_expected->>v_key)::numeric, 0), 2) THEN
            RAISE EXCEPTION 'INCONSISTENT_COLUMNS: a points redemption may not change %', v_key;
        END IF;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------- redeem

CREATE OR REPLACE FUNCTION public.redeem_points_atomic(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_tenant uuid := NULLIF(p->>'tenant_id', '')::uuid;
    v_invoice uuid := NULLIF(p->>'invoice_id', '')::uuid;
    v_key text := NULLIF(btrim(COALESCE(p->>'reference_key', p->>'idempotency_key', ''), E' \t\r\n'), '');
    v_target text := p->>'target';
    v_points int := (p->>'points_to_spend')::int;
    v_baht numeric := round((p->>'baht_applied')::numeric, 2);
    v_ppb numeric := (p->>'points_per_baht')::numeric;
    v_max_baht numeric := (p->>'max_redemption_baht')::numeric;
    v_max_per_month int := (p->>'max_redemptions_per_month')::int;
    v_expected jsonb := p->'expected';
    v_new jsonb := p->'new';
    v_created_by uuid := NULLIF(p->>'created_by', '')::uuid;
    v_actor text := NULLIF(btrim(COALESCE(p->>'actor', '')), '');
    v_existing public.point_ledger_entries%ROWTYPE;
    v_inv public.invoices%ROWTYPE;
    v_inv_out public.invoices%ROWTYPE;
    v_month_start timestamptz;
    v_used int;
    v_balance bigint;
    v_target_charge numeric;
    v_cap_target numeric;
    v_cap_unpaid numeric;
    v_label text;
    v_adj_id uuid;
    v_entry public.point_ledger_entries%ROWTYPE;
BEGIN
    -- 0. Input validation (nothing locked yet).
    IF v_key IS NULL THEN
        RAISE EXCEPTION 'A reference key is required to redeem points.';
    END IF;
    IF v_key LIKE '%:reversal' THEN
        RAISE EXCEPTION 'Reference keys ending in :reversal are reserved for reversals.';
    END IF;
    IF v_tenant IS NULL OR v_invoice IS NULL THEN
        RAISE EXCEPTION 'tenant_id and invoice_id are required.';
    END IF;
    IF v_target IS NULL OR v_target NOT IN ('rent', 'utility') THEN
        RAISE EXCEPTION 'target must be rent or utility.';
    END IF;
    IF v_points IS NULL OR v_points <= 0 THEN
        RAISE EXCEPTION 'Points to redeem must be greater than zero.';
    END IF;
    IF v_ppb IS NULL OR v_ppb <= 0 THEN
        RAISE EXCEPTION 'points_per_baht must be positive.';
    END IF;
    IF v_max_baht IS NULL OR v_max_per_month IS NULL THEN
        RAISE EXCEPTION 'max_redemption_baht and max_redemptions_per_month are required.';
    END IF;

    -- 1. Lock the invoice.
    SELECT * INTO v_inv FROM public.invoices WHERE id = v_invoice FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice not found.';
    END IF;
    IF v_inv.tenant_id IS DISTINCT FROM v_tenant THEN
        RAISE EXCEPTION 'Invoice does not belong to this tenant.';
    END IF;

    -- 2. Lock the tenant's point rows in a fixed order (per-tenant mutex).
    PERFORM 1 FROM public.point_ledger_entries WHERE tenant_id = v_tenant ORDER BY id FOR UPDATE;

    -- 3. Replay: checked after the locks, so a concurrent twin sees the winner's rows.
    SELECT * INTO v_existing FROM public.point_ledger_entries WHERE idempotency_key = v_key;
    IF FOUND THEN
        IF v_existing.tenant_id <> v_tenant
           OR v_existing.reason <> 'redemption'
           OR v_existing.reference_id IS DISTINCT FROM v_invoice THEN
            RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: key % belongs to a different operation', v_key;
        END IF;
        RETURN jsonb_build_object(
            'replay', true,
            'points_spent', abs(v_existing.points),
            'baht_applied', v_existing.baht_equivalent,
            'ledger_entry', to_jsonb(v_existing),
            'invoice', to_jsonb(v_inv),
            'adjustment_id', (SELECT id FROM public.adjustments WHERE reference_key = v_key)
        );
    END IF;
    IF EXISTS (SELECT 1 FROM public.adjustments WHERE reference_key = v_key) THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: key % belongs to a different operation', v_key;
    END IF;

    -- 4. Invoice state.
    IF v_inv.status::text NOT IN ('pending', 'overdue', 'partial') THEN
        RAISE EXCEPTION 'This invoice is not open for redemption.';
    END IF;
    PERFORM public.points_assert_invoice_unchanged(v_inv, v_expected);

    -- 5. Points <-> baht at the frozen rate.
    IF v_baht IS NULL OR v_baht <= 0 THEN
        RAISE EXCEPTION 'Nothing available to redeem against this invoice.';
    END IF;
    IF abs(v_baht - (v_points / v_ppb)) > 0.005 THEN
        RAISE EXCEPTION 'RATIO_MISMATCH: % points at % points/baht is not % baht.', v_points, v_ppb, v_baht;
    END IF;

    -- 6. Discount cap: rent/utilities only.
    v_target_charge := CASE WHEN v_target = 'rent'
        THEN COALESCE(v_inv.rent_amount, 0)
        ELSE COALESCE(v_inv.water_bill, 0) + COALESCE(v_inv.electricity_bill, 0) END;
    v_cap_target := v_target_charge - COALESCE(v_inv.discount_amount, 0);
    v_cap_unpaid := COALESCE(v_inv.rent_amount, 0) + COALESCE(v_inv.water_bill, 0)
                    + COALESCE(v_inv.electricity_bill, 0)
                    - COALESCE(v_inv.discount_amount, 0) - COALESCE(v_inv.paid_amount, 0);
    IF v_baht > v_max_baht THEN
        RAISE EXCEPTION 'DISCOUNT_CAP: % exceeds the per-redemption cap %.', v_baht, v_max_baht;
    END IF;
    IF v_baht > GREATEST(0, LEAST(v_cap_target, v_cap_unpaid)) THEN
        RAISE EXCEPTION 'DISCOUNT_CAP: % exceeds the redeemable % charge % (rent/utilities only; never late fees, other fees or carried debt).',
            v_baht, v_target, GREATEST(0, LEAST(v_cap_target, v_cap_unpaid));
    END IF;
    PERFORM public.points_assert_new_columns(v_expected, v_new, v_baht);

    -- 7. Monthly limit (Bangkok calendar month; reversed redemptions still count).
    v_month_start := (date_trunc('month', now() AT TIME ZONE 'Asia/Bangkok')) AT TIME ZONE 'Asia/Bangkok';
    SELECT count(*) INTO v_used
    FROM public.point_ledger_entries
    WHERE tenant_id = v_tenant AND reason = 'redemption' AND created_at >= v_month_start;
    IF v_used >= v_max_per_month THEN
        RAISE EXCEPTION 'MONTHLY_LIMIT: Redemption limit for this month has already been used.';
    END IF;

    -- 8. Balance (non-expired points, same rule as getTenantPointBalance).
    SELECT COALESCE(SUM(points), 0) INTO v_balance
    FROM public.point_ledger_entries
    WHERE tenant_id = v_tenant AND (expires_at IS NULL OR expires_at > now());
    IF v_balance < v_points THEN
        RAISE EXCEPTION 'INSUFFICIENT_POINTS: Insufficient point balance (% available, % requested).', v_balance, v_points;
    END IF;

    -- 9. Write both sides under the one key. A unique violation here means a twin
    -- request won a race we did not see; replay it if it is the same operation.
    BEGIN
        INSERT INTO public.point_ledger_entries
            (tenant_id, points, reason, reference_type, reference_id, baht_equivalent,
             expires_at, idempotency_key, created_by, notes)
        VALUES
            (v_tenant, -v_points, 'redemption', 'invoice', v_invoice, v_baht,
             NULL, v_key, v_created_by,
             CASE WHEN v_target = 'rent' THEN 'Redeemed toward rent' ELSE 'Redeemed toward utility bill' END)
        RETURNING * INTO v_entry;

        INSERT INTO public.adjustments
            (type, amount, invoice_id, tenant_id, reason, actor, source, reference_key)
        VALUES
            ('points_redemption', v_baht, v_invoice, v_tenant,
             'Points redemption (' || v_target || '): ' || v_points || ' points', v_actor,
             'points_redemption', v_key)
        RETURNING id INTO v_adj_id;
    EXCEPTION WHEN unique_violation THEN
        SELECT * INTO v_existing FROM public.point_ledger_entries WHERE idempotency_key = v_key;
        IF FOUND AND v_existing.tenant_id = v_tenant AND v_existing.reason = 'redemption'
           AND v_existing.reference_id = v_invoice THEN
            SELECT * INTO v_inv_out FROM public.invoices WHERE id = v_invoice;
            RETURN jsonb_build_object(
                'replay', true,
                'points_spent', abs(v_existing.points),
                'baht_applied', v_existing.baht_equivalent,
                'ledger_entry', to_jsonb(v_existing),
                'invoice', to_jsonb(v_inv_out),
                'adjustment_id', (SELECT id FROM public.adjustments WHERE reference_key = v_key)
            );
        END IF;
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: key % conflicts with an existing row', v_key;
    END;

    v_label := CASE WHEN v_target = 'rent'
        THEN 'แลกคะแนนสะสม (ส่วนลดค่าเช่า)' ELSE 'แลกคะแนนสะสม (ส่วนลดค่าน้ำ-ไฟ)' END;

    UPDATE public.invoices
    SET total_amount = (v_new->>'total_amount')::numeric,
        discount_amount = (v_new->>'discount_amount')::numeric,
        discount_breakdown =
            (CASE WHEN jsonb_typeof(discount_breakdown) = 'array' THEN discount_breakdown ELSE '[]'::jsonb END)
            || jsonb_build_array(jsonb_build_object(
                'detail', v_label, 'label', v_label, 'unit', 1,
                'price_per_unit', v_baht, 'total_amount', v_baht, 'amount', v_baht,
                'source', 'rewards_redemption', 'target', v_target, 'reference_key', v_key,
                'ledger_entry_id', v_entry.id, 'adjustment_id', v_adj_id))
    WHERE id = v_invoice
    RETURNING * INTO v_inv_out;

    INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, room_id, before, after, reason, source)
    VALUES ('points.redeem', COALESCE(v_actor, v_created_by::text), v_tenant, v_invoice, v_inv.room_id,
            jsonb_build_object('total_amount', v_inv.total_amount, 'discount_amount', v_inv.discount_amount,
                               'points_balance', v_balance),
            jsonb_build_object('total_amount', v_inv_out.total_amount, 'discount_amount', v_inv_out.discount_amount,
                               'points_balance', v_balance - v_points, 'points_spent', v_points,
                               'baht_discount', v_baht, 'points_per_baht', v_ppb, 'target', v_target,
                               'reference_key', v_key, 'ledger_entry_id', v_entry.id, 'adjustment_id', v_adj_id),
            'Points redemption', 'points_redemption');

    RETURN jsonb_build_object(
        'replay', false,
        'points_spent', v_points,
        'baht_applied', v_baht,
        'ledger_entry', to_jsonb(v_entry),
        'invoice', to_jsonb(v_inv_out),
        'adjustment_id', v_adj_id
    );
END;
$$;

-- ---------------------------------------------------------------- reverse

CREATE OR REPLACE FUNCTION public.reverse_points_redemption(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_entry_id uuid := NULLIF(p->>'entry_id', '')::uuid;
    v_reason text := NULLIF(btrim(COALESCE(p->>'reason', ''), E' \t\r\n'), '');
    v_expected jsonb := p->'expected';
    v_new jsonb := p->'new';
    v_created_by uuid := NULLIF(p->>'created_by', '')::uuid;
    v_actor text := NULLIF(btrim(COALESCE(p->>'actor', '')), '');
    v_orig public.point_ledger_entries%ROWTYPE;
    v_inv public.invoices%ROWTYPE;
    v_inv_out public.invoices%ROWTYPE;
    v_orig_adj public.adjustments%ROWTYPE;
    v_key text;
    v_rev_key text;
    v_rev public.point_ledger_entries%ROWTYPE;
    v_adj_id uuid;
    v_removed boolean := false;
    v_breakdown jsonb := '[]'::jsonb;
    v_elems jsonb;
    v_idx int;
    v_drop int := NULL;
BEGIN
    IF v_entry_id IS NULL THEN
        RAISE EXCEPTION 'entry_id is required.';
    END IF;
    IF v_reason IS NULL THEN
        RAISE EXCEPTION 'A reversal reason is required.';
    END IF;

    -- Unlocked read only to find which invoice/tenant to lock.
    SELECT * INTO v_orig FROM public.point_ledger_entries WHERE id = v_entry_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ledger entry not found.';
    END IF;
    IF v_orig.reason <> 'redemption' OR v_orig.points >= 0 THEN
        RAISE EXCEPTION 'Only redemption entries can be reversed.';
    END IF;
    IF v_orig.reference_id IS NULL OR v_orig.reference_type IS DISTINCT FROM 'invoice' THEN
        RAISE EXCEPTION 'Redemption has no invoice to restore.';
    END IF;

    -- Same lock order as redeem: invoice, then the tenant's point rows.
    SELECT * INTO v_inv FROM public.invoices WHERE id = v_orig.reference_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice not found.';
    END IF;
    PERFORM 1 FROM public.point_ledger_entries WHERE tenant_id = v_orig.tenant_id ORDER BY id FOR UPDATE;
    SELECT * INTO v_orig FROM public.point_ledger_entries WHERE id = v_entry_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ledger entry not found.';
    END IF;

    IF EXISTS (SELECT 1 FROM public.point_ledger_entries WHERE reverses_entry_id = v_orig.id) THEN
        RAISE EXCEPTION 'ALREADY_REVERSED: redemption % has already been reversed.', v_orig.id;
    END IF;
    IF v_inv.tenant_id IS DISTINCT FROM v_orig.tenant_id THEN
        RAISE EXCEPTION 'Invoice no longer belongs to the redeeming tenant.';
    END IF;
    IF v_inv.status::text NOT IN ('pending', 'overdue', 'partial') THEN
        RAISE EXCEPTION 'INVOICE_CLOSED: invoice is %; a redemption on a paid/cancelled invoice cannot be reversed here.',
            v_inv.status;
    END IF;
    PERFORM public.points_assert_invoice_unchanged(v_inv, v_expected);
    IF COALESCE(v_inv.discount_amount, 0) < v_orig.baht_equivalent THEN
        RAISE EXCEPTION 'Invoice discount (%) is smaller than the redemption being reversed (%).',
            COALESCE(v_inv.discount_amount, 0), v_orig.baht_equivalent;
    END IF;
    PERFORM public.points_assert_new_columns(v_expected, v_new, -v_orig.baht_equivalent);

    v_key := COALESCE(v_orig.idempotency_key, 'redemption:' || v_orig.id::text);
    v_rev_key := v_key || ':reversal';
    IF EXISTS (SELECT 1 FROM public.adjustments WHERE reference_key = v_rev_key)
       OR EXISTS (SELECT 1 FROM public.point_ledger_entries WHERE idempotency_key = v_rev_key) THEN
        RAISE EXCEPTION 'ALREADY_REVERSED: reversal key % already exists.', v_rev_key;
    END IF;

    -- Points side: a new positive row linked to the original. Not counted by the
    -- monthly limit (reason differs), so the slot used by the original stays used.
    INSERT INTO public.point_ledger_entries
        (tenant_id, points, reason, reference_type, reference_id, baht_equivalent,
         expires_at, idempotency_key, created_by, notes, reverses_entry_id)
    VALUES
        (v_orig.tenant_id, abs(v_orig.points), 'redemption_reversal', 'invoice', v_orig.reference_id,
         v_orig.baht_equivalent, NULL, v_rev_key, v_created_by, v_reason, v_orig.id)
    RETURNING * INTO v_rev;

    -- Invoice side: opposite-sign adjustment sharing the reversal key.
    SELECT * INTO v_orig_adj FROM public.adjustments WHERE reference_key = v_key;
    IF FOUND THEN
        IF v_orig_adj.amount <> v_orig.baht_equivalent OR v_orig_adj.invoice_id IS DISTINCT FROM v_orig.reference_id THEN
            RAISE EXCEPTION 'PAIR_MISMATCH: adjustment % does not match redemption % (amount % vs %).',
                v_orig_adj.id, v_orig.id, v_orig_adj.amount, v_orig.baht_equivalent;
        END IF;
        INSERT INTO public.adjustments
            (type, amount, invoice_id, tenant_id, reason, actor, source, reverses_adjustment_id, reference_key)
        VALUES
            ('reversal', -v_orig_adj.amount, v_orig.reference_id, v_orig.tenant_id,
             v_reason, v_actor, 'points_redemption_reversal', v_orig_adj.id, v_rev_key)
        RETURNING id INTO v_adj_id;
    ELSE
        -- Legacy redemption made before the adjustments table: there is no row to
        -- point at, so record a negative correction rather than backfilling a fake
        -- original discount.
        INSERT INTO public.adjustments
            (type, amount, invoice_id, tenant_id, reason, actor, source, reference_key)
        VALUES
            ('correction', -v_orig.baht_equivalent, v_orig.reference_id, v_orig.tenant_id,
             v_reason || ' (legacy redemption ' || v_orig.id::text || ')', v_actor,
             'points_redemption_reversal', v_rev_key)
        RETURNING id INTO v_adj_id;
    END IF;

    -- Drop exactly one display line from discount_breakdown: the one carrying this
    -- key; failing that (legacy line, or key lost by an invoice edit), the first
    -- rewards line without a key and with the same amount.
    v_elems := CASE WHEN jsonb_typeof(v_inv.discount_breakdown) = 'array' THEN v_inv.discount_breakdown ELSE '[]'::jsonb END;
    SELECT (ord - 1)::int INTO v_drop
    FROM jsonb_array_elements(v_elems) WITH ORDINALITY AS e(val, ord)
    WHERE e.val->>'source' = 'rewards_redemption' AND e.val->>'reference_key' = v_key
    ORDER BY ord LIMIT 1;
    IF v_drop IS NULL THEN
        SELECT (ord - 1)::int INTO v_drop
        FROM jsonb_array_elements(v_elems) WITH ORDINALITY AS e(val, ord)
        WHERE e.val->>'source' = 'rewards_redemption'
          AND (e.val->>'reference_key') IS NULL
          AND round(COALESCE((e.val->>'amount')::numeric, (e.val->>'total_amount')::numeric, -1), 2)
              = round(v_orig.baht_equivalent, 2)
        ORDER BY ord LIMIT 1;
    END IF;
    FOR v_idx IN 0 .. jsonb_array_length(v_elems) - 1 LOOP
        IF v_drop IS NOT NULL AND v_idx = v_drop THEN
            v_removed := true;
        ELSE
            v_breakdown := v_breakdown || jsonb_build_array(v_elems->v_idx);
        END IF;
    END LOOP;

    UPDATE public.invoices
    SET total_amount = (v_new->>'total_amount')::numeric,
        discount_amount = (v_new->>'discount_amount')::numeric,
        discount_breakdown = v_breakdown
    WHERE id = v_inv.id
    RETURNING * INTO v_inv_out;

    INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, room_id, before, after, reason, source)
    VALUES ('points.redeem_reversal', COALESCE(v_actor, v_created_by::text), v_orig.tenant_id, v_inv.id, v_inv.room_id,
            jsonb_build_object('total_amount', v_inv.total_amount, 'discount_amount', v_inv.discount_amount),
            jsonb_build_object('total_amount', v_inv_out.total_amount, 'discount_amount', v_inv_out.discount_amount,
                               'points_returned', abs(v_orig.points), 'baht_restored', v_orig.baht_equivalent,
                               'reverses_entry_id', v_orig.id, 'reversal_entry_id', v_rev.id,
                               'reference_key', v_rev_key, 'adjustment_id', v_adj_id,
                               'breakdown_line_removed', v_removed,
                               'monthly_limit_slot_returned', false),
            v_reason, 'points_redemption_reversal');

    RETURN jsonb_build_object(
        'original_entry', to_jsonb(v_orig),
        'reversal_entry', to_jsonb(v_rev),
        'invoice', to_jsonb(v_inv_out),
        'adjustment_id', v_adj_id,
        'points_returned', abs(v_orig.points),
        'baht_restored', v_orig.baht_equivalent,
        'breakdown_line_removed', v_removed
    );
END;
$$;

-- Service role only: written by server routes, never by clients.
REVOKE ALL ON FUNCTION public.redeem_points_atomic(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reverse_points_redemption(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.points_assert_invoice_unchanged(public.invoices, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.points_assert_new_columns(jsonb, jsonb, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_points_atomic(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_points_redemption(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.points_assert_invoice_unchanged(public.invoices, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.points_assert_new_columns(jsonb, jsonb, numeric) TO service_role;
