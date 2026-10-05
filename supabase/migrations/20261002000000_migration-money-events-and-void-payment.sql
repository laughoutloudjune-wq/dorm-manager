-- Money audit log + append-only payment void/reversal
--
-- Additive only. No existing row is modified by this migration, and it is NOT
-- applied automatically: run it deliberately in the Supabase SQL editor.
--
-- 1. money_events: append-only log of every money-affecting admin action
--    (action, actor, before/after, reason). Written by lib/money-events.ts.
-- 2. payment_batches gains voided_at/voided_by/void_reason, and
--    invoice_payment_allocations gains reverses_allocation_id, so a void is
--    recorded as NEW negative allocation rows pointing at the originals.
--    Anything that sums allocations nets to zero without code changes, and the
--    original receipt and allocations stay visible next to their reversal.
-- 3. void_payment_batch(): does the whole void in one transaction, with the
--    batch row locked so two admins (or a double click) cannot void it twice.
-- 4. money_derive_invoice_status(): THE one rule for an invoice's status after
--    money moves, shared by record_payment_batch, void_payment_batch and
--    final_settle_move_out (finding 146):
--      paid    iff paid_amount >= total_amount, OR (carry-forward target, finding 174)
--              paid_amount > 0 and paid_amount + settled carried-in >= total_amount
--              (money_derive_invoice_status_cf; carried-in = invoice_carry_forwards
--              amounts whose source invoice is fully settled)
--      partial iff 0 < paid_amount < total_amount
--      overdue iff nothing paid and due_date < today (Asia/Bangkok)
--      pending otherwise
--    Same rule as resolveInvoiceStatus in lib/invoice-ledger.ts.
--
-- GLOBAL LOCK ORDER (every money function in 0000-0800 follows it, finding 144):
--      tenant row -> room row -> invoice rows (ascending id) -> every other row
--      (payment_batches, tenant_credits, point_ledger_entries, ...)
-- A function may skip a level it does not need, never reorder two levels.
--
-- Idempotent: safe to re-run (IF NOT EXISTS / DROP ... IF EXISTS / OR REPLACE).
--
-- ROLLBACK (only before any money has been recorded through the new code):
--   DROP FUNCTION IF EXISTS public.void_payment_batch(uuid, text, text);
--   DROP FUNCTION IF EXISTS public.money_derive_invoice_status_cf(UUID, NUMERIC, NUMERIC, DATE, DATE, JSONB);
--   DROP FUNCTION IF EXISTS public.money_derive_invoice_status(numeric, numeric, date, date);
--   ALTER TABLE public.payment_batches DROP CONSTRAINT IF EXISTS payment_batches_void_reason_check;
--   DROP INDEX IF EXISTS public.uq_allocation_single_reversal;
--   ALTER TABLE public.invoice_payment_allocations
--       DROP COLUMN IF EXISTS reverses_allocation_id, DROP COLUMN IF EXISTS reversed_at,
--       DROP COLUMN IF EXISTS reversal_reason;
--   ALTER TABLE public.payment_batches
--       DROP COLUMN IF EXISTS voided_at, DROP COLUMN IF EXISTS voided_by, DROP COLUMN IF EXISTS void_reason;
--   DROP TRIGGER IF EXISTS trg_money_events_append_only ON public.money_events;
--   DROP TABLE IF EXISTS public.money_events;
--   DROP FUNCTION IF EXISTS public.money_events_block_mutation();
-- Dropping the void columns or money_events once a void or an event exists
-- DESTROYS audit data (the negative reversal allocations would remain but lose
-- their link). After real data exists, do not run these: restore from the
-- backup taken before go-live instead.

-- Fail fast instead of queueing behind live traffic (ALTER TABLE on
-- payment_batches, CREATE UNIQUE INDEX on allocations). Re-run off-hours if hit.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.money_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action TEXT NOT NULL,
    actor_user_id TEXT,
    tenant_id UUID,
    invoice_id UUID,
    payment_batch_id UUID,
    room_id UUID,
    before JSONB,
    after JSONB,
    reason TEXT,
    source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deliberately no FKs: the log must survive deletion of the thing it describes.
CREATE INDEX IF NOT EXISTS idx_money_events_created_at ON public.money_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_money_events_invoice ON public.money_events(invoice_id);
CREATE INDEX IF NOT EXISTS idx_money_events_batch ON public.money_events(payment_batch_id);
CREATE INDEX IF NOT EXISTS idx_money_events_tenant ON public.money_events(tenant_id);

CREATE OR REPLACE FUNCTION public.money_events_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'money_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_money_events_append_only ON public.money_events;
CREATE TRIGGER trg_money_events_append_only
    BEFORE UPDATE OR DELETE ON public.money_events
    FOR EACH ROW EXECUTE FUNCTION public.money_events_block_mutation();

ALTER TABLE public.money_events ENABLE ROW LEVEL SECURITY;  -- service role only

ALTER TABLE public.payment_batches
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS voided_by TEXT,
    ADD COLUMN IF NOT EXISTS void_reason TEXT;

ALTER TABLE public.invoice_payment_allocations
    ADD COLUMN IF NOT EXISTS reverses_allocation_id UUID,
    ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reversal_reason TEXT;

-- An allocation can be reversed at most once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_allocation_single_reversal
    ON public.invoice_payment_allocations(reverses_allocation_id)
    WHERE reverses_allocation_id IS NOT NULL;

-- A voided batch must say why. Whitespace-only (incl. tab/newline) is blank.
ALTER TABLE public.payment_batches DROP CONSTRAINT IF EXISTS payment_batches_void_reason_check;
ALTER TABLE public.payment_batches ADD CONSTRAINT payment_batches_void_reason_check
    CHECK (voided_at IS NULL OR (void_reason IS NOT NULL AND void_reason ~ '[^[:space:]]'));

-- money_derive_invoice_status(): the single paid/partial/overdue/pending rule.
CREATE OR REPLACE FUNCTION public.money_derive_invoice_status(
    p_total NUMERIC, p_paid NUMERIC, p_due DATE, p_today DATE
) RETURNS public.invoice_status
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT (CASE
        WHEN COALESCE(p_paid, 0) >= COALESCE(p_total, 0) THEN 'paid'
        WHEN COALESCE(p_paid, 0) > 0 THEN 'partial'
        WHEN p_due IS NOT NULL AND p_due < p_today THEN 'overdue'
        ELSE 'pending'
    END)::public.invoice_status
$$;

COMMENT ON FUNCTION public.money_derive_invoice_status(NUMERIC, NUMERIC, DATE, DATE) IS
    'The one invoice-status rule after money moves: paid iff paid_amount >= total_amount; partial iff 0 < paid < total; else overdue (due_date < p_today) or pending. Mirrors resolveInvoiceStatus (lib/invoice-ledger.ts).';

REVOKE ALL ON FUNCTION public.money_derive_invoice_status(NUMERIC, NUMERIC, DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.money_derive_invoice_status(NUMERIC, NUMERIC, DATE, DATE) TO service_role;

-- money_derive_invoice_status_cf(): the SAME rule plus carried-in debt (finding 174).
-- A carry-forward target (May total 7,594 includes April's 1,400) counts as paid
-- when its OWN paid_amount > 0 and paid_amount + the amounts carried into it from
-- SOURCE invoices that are fully settled (paid_amount >= total_amount, total > 0,
-- not cancelled; per invoice_carry_forwards) >= total_amount. p_overrides is a jsonb
-- object {invoice_id: paid_amount} giving source paid amounts as they will be after
-- the statement in flight (so order of updates inside a batch does not matter).
-- Everything else falls through to money_derive_invoice_status.
CREATE OR REPLACE FUNCTION public.money_derive_invoice_status_cf(
    p_invoice_id UUID, p_total NUMERIC, p_paid NUMERIC, p_due DATE, p_today DATE,
    p_overrides JSONB DEFAULT '{}'::jsonb
) RETURNS public.invoice_status
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_carried NUMERIC;
    v_carry NUMERIC;
BEGIN
    SELECT COALESCE(carry_forward_amount, 0) INTO v_carry FROM public.invoices WHERE id = p_invoice_id;
    -- A row whose paid_amount exceeds its own charge (total - carry) was written before the own-share
    -- model and already includes the carried part: never add the carried-in credit on top of it.
    IF COALESCE(p_paid, 0) > 0 AND COALESCE(p_paid, 0) < COALESCE(p_total, 0)
       AND NOT (COALESCE(v_carry, 0) > 0 AND COALESCE(p_paid, 0) > round(COALESCE(p_total, 0) - v_carry, 2)) THEN
        v_carried := public.money_carried_in_settled(p_invoice_id, p_overrides);
        IF COALESCE(p_paid, 0) + v_carried >= COALESCE(p_total, 0) THEN
            RETURN 'paid'::public.invoice_status;
        END IF;
    END IF;
    RETURN public.money_derive_invoice_status(p_total, p_paid, p_due, p_today);
END;
$$;

-- Carry-forward helpers (findings 178, 174): recursive 'settled' test, downstream closure,
-- and the downstream status re-derive used by record_payment_batch / void_payment_batch.
-- A source counts as settled when paid_amount >= total, or (recursive) own paid > 0 and
-- own paid + ITS settled carried-in >= total, so a chain A->B->C propagates.
-- A legacy-shaped source (paid_amount > total - carry: its paid already includes the carried part)
-- is never settled by the recursive rule: it still owes total - paid (room 114/1: 244).

CREATE OR REPLACE FUNCTION public.money_carried_in_settled(
    p_invoice_id UUID, p_overrides JSONB DEFAULT '{}'::jsonb, p_depth INT DEFAULT 0
) RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    r RECORD;
    v_sum NUMERIC := 0;
BEGIN
    IF p_depth > 12 THEN
        RETURN 0;  -- cycle / absurd depth: treat as not settled (conservative)
    END IF;
    FOR r IN
        SELECT cf.amount AS amount, s.id AS sid, s.status::text AS status,
               COALESCE(s.total_amount, 0) AS total, COALESCE(s.carry_forward_amount, 0) AS carry,
               COALESCE(CASE WHEN p_overrides ? s.id::text THEN (p_overrides->>s.id::text)::numeric END,
                        s.paid_amount, 0) AS paid
        FROM public.invoice_carry_forwards cf
        JOIN public.invoices s ON s.id = cf.source_invoice_id
        WHERE cf.target_invoice_id = p_invoice_id AND cf.source_invoice_id <> p_invoice_id
    LOOP
        CONTINUE WHEN r.status = 'cancelled' OR r.total <= 0;
        IF r.paid >= r.total
           OR (r.paid > 0 AND NOT (r.carry > 0 AND r.paid > round(r.total - r.carry, 2))
               AND r.paid + public.money_carried_in_settled(r.sid, p_overrides, p_depth + 1) >= r.total) THEN
            v_sum := v_sum + COALESCE(r.amount, 0);
        END IF;
    END LOOP;
    RETURN v_sum;
END;
$$;

CREATE OR REPLACE FUNCTION public.money_downstream_ids(p_ids UUID[]) RETURNS UUID[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    WITH RECURSIVE d(id, depth, path) AS (
        SELECT cf.target_invoice_id, 1, ARRAY[cf.source_invoice_id, cf.target_invoice_id]
        FROM public.invoice_carry_forwards cf
        WHERE cf.source_invoice_id = ANY(COALESCE(p_ids, '{}')) AND cf.target_invoice_id <> cf.source_invoice_id
        UNION ALL
        SELECT cf.target_invoice_id, d.depth + 1, d.path || cf.target_invoice_id
        FROM d JOIN public.invoice_carry_forwards cf ON cf.source_invoice_id = d.id
        WHERE NOT cf.target_invoice_id = ANY(d.path) AND d.depth < 12
    )
    SELECT COALESCE(array_agg(DISTINCT id ORDER BY id), '{}'::uuid[]) FROM d
$$;

CREATE OR REPLACE FUNCTION public.money_late_fee_amount(
    p_start DATE, p_rate NUMERIC, p_waived NUMERIC, p_locked NUMERIC, p_as_of DATE
) RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN p_locked IS NOT NULL THEN GREATEST(0, p_locked)
        WHEN p_start IS NULL OR COALESCE(p_rate, 0) <= 0 OR p_as_of IS NULL OR p_as_of < p_start THEN 0
        ELSE GREATEST(0, round(((p_as_of - p_start) + 1) * p_rate - GREATEST(0, COALESCE(p_waived, 0)), 2))
    END
$$;

COMMENT ON FUNCTION public.money_late_fee_amount(DATE, NUMERIC, NUMERIC, NUMERIC, DATE) IS
    'SQL twin of calculateLateFeeAmount (lib/invoice-ledger.ts): a frozen amount wins; else (inclusive days from late_fee_start_date to the as-of date) x late_fee_per_day minus waived, floored at 0. Keep in step with the TS function; parity fixtures in lib/money/late-fee-freeze.test.ts and supabase/tests/09_late_fee_freeze.sql.';

DROP FUNCTION IF EXISTS public.money_rederive_downstream(UUID[], JSONB, DATE, UUID, TEXT, UUID, TEXT);

CREATE OR REPLACE FUNCTION public.money_rederive_downstream(
    p_source_ids UUID[], p_overrides JSONB, p_today DATE, p_batch_id UUID,
    p_actor TEXT, p_tenant UUID, p_source TEXT, p_paid_date TEXT DEFAULT NULL
) RETURNS UUID[]
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    t public.invoices%ROWTYPE;
    v_new public.invoice_status;
    v_lock NUMERIC;
    v_flipped UUID[] := '{}';
BEGIN
    FOR t IN
        SELECT * FROM public.invoices WHERE id = ANY(public.money_downstream_ids(p_source_ids)) ORDER BY id
    LOOP
        IF p_tenant IS NOT NULL AND t.tenant_id IS DISTINCT FROM p_tenant THEN
            RAISE EXCEPTION 'CROSS_TENANT_CARRY invoice % belongs to another tenant than the payment', t.id;
        END IF;
        CONTINUE WHEN t.status::text IN ('cancelled', 'draft');
        CONTINUE WHEN t.status::text = 'verifying' AND NULLIF(btrim(COALESCE(t.slip_url, ''), E' \t\r\n'), '') IS NOT NULL;
        v_new := public.money_derive_invoice_status_cf(t.id, t.total_amount, t.paid_amount, t.due_date, p_today, p_overrides);
        IF v_new IS DISTINCT FROM t.status THEN
            v_lock := t.locked_late_fee_amount;
            IF t.status::text = 'paid' AND v_new::text <> 'paid' THEN
                v_lock := NULL;
            ELSIF v_new::text = 'paid' AND v_lock IS NULL AND p_paid_date IS NOT NULL THEN
                -- Same rule and effective date as the normal payment path: freeze the fee as of the
                -- payment date, only when nothing froze it already.
                v_lock := public.money_late_fee_amount(t.late_fee_start_date, t.late_fee_per_day,
                                                       t.waived_late_fee_amount, NULL, p_paid_date::date);
            END IF;
            UPDATE public.invoices SET status = v_new, locked_late_fee_amount = v_lock WHERE id = t.id;
            INSERT INTO public.money_events (action, actor_user_id, tenant_id, invoice_id, payment_batch_id,
                                             before, after, reason, source)
            VALUES ('invoice.status_rederive', p_actor, t.tenant_id, t.id, p_batch_id,
                    jsonb_build_object('status', t.status, 'locked_late_fee_amount', t.locked_late_fee_amount),
                    jsonb_build_object('status', v_new, 'locked_late_fee_amount', v_lock),
                    'carry-forward source changed', p_source);
            v_flipped := v_flipped || t.id;
        END IF;
    END LOOP;
    RETURN v_flipped;
END;
$$;



REVOKE ALL ON FUNCTION public.money_carried_in_settled(UUID, JSONB, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.money_carried_in_settled(UUID, JSONB, INT) TO service_role;
REVOKE ALL ON FUNCTION public.money_downstream_ids(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.money_downstream_ids(UUID[]) TO service_role;
REVOKE ALL ON FUNCTION public.money_late_fee_amount(DATE, NUMERIC, NUMERIC, NUMERIC, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.money_late_fee_amount(DATE, NUMERIC, NUMERIC, NUMERIC, DATE) TO service_role;
REVOKE ALL ON FUNCTION public.money_rederive_downstream(UUID[], JSONB, DATE, UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.money_rederive_downstream(UUID[], JSONB, DATE, UUID, TEXT, UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.money_derive_invoice_status_cf(UUID, NUMERIC, NUMERIC, DATE, DATE, JSONB) IS
    'money_derive_invoice_status plus carried-in: paid when own paid > 0 and paid + settled carried-in >= total (finding 174). Mirrors resolveInvoiceStatusWithCarry (lib/invoice-ledger.ts).';

REVOKE ALL ON FUNCTION public.money_derive_invoice_status_cf(UUID, NUMERIC, NUMERIC, DATE, DATE, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.money_derive_invoice_status_cf(UUID, NUMERIC, NUMERIC, DATE, DATE, JSONB) TO service_role;

-- void_payment_batch()
--
-- Runtime requirement: 20261002000200 (tenant_credits, incl. reverses_credit_id)
-- and 20261002000300 (refund_payouts). plpgsql resolves tables at call time, so
-- creating this function before those migrations is fine; calling it before is not.
--
-- Rules:
--  * Reason required; whitespace-only (spaces, tabs, newlines) is blank.
--  * Lock order (global order, see top of file): tenant row (batch.tenant_id,
--    else the trigger invoice's tenant) -> every touched invoice in ascending id
--    order -> the batch row. The batch row is re-read under its lock, so two
--    concurrent voids of the same batch still serialise and the second sees
--    'already voided'.
--  * Settlement / credit receipts cannot be voided here (finding 141): a batch
--    with mode 'credit', an idempotency key starting 'settle:', or any
--    tenant_credits 'applied_to_invoice' row pointing at it was written by
--    final_settle_move_out; reversing only its allocations would reopen the
--    debts while the credit stays spent (double charge). Error VOID_NOT_ALLOWED.
--  * All checks run before any write. Refuses (naming the invoice) when the
--    void would take an invoice's paid_amount below 0, i.e. paid_amount was
--    edited down after this receipt.
--  * Status after void (finding 146, money_derive_invoice_status):
--      cancelled / draft  -> unchanged (never silently reopened)
--      verifying          -> unchanged while a slip is awaiting review (slip_url
--                            set and not the slip this receipt was recorded
--                            from); otherwise treated like paid/partial
--      paid / partial     -> money_derive_invoice_status(total, new paid, due, today Bangkok)
--      pending / overdue  -> unchanged
--  * Leaving 'paid' clears locked_late_fee_amount (finding 147, same rule as the
--    admin status change): the frozen fee is re-frozen when it is paid again.
--  * The batch's tenant_credits 'overpayment' rows are reversed by paired
--    'reversal' rows (reverses_credit_id, unique). Refused (VOID_CREDIT_ALREADY_USED)
--    if that credit was already spent from the unapplied bucket, OR already paid
--    out: refundable credit (deposit + unapplied, excluding 'refunded' rows, as
--    refund_due_vs_paid counts it) minus live refund_payouts must still cover
--    the credit being reversed (finding 142).
--  * One 'payment.void' money_events row per invoice, one 'credit.reversal'
--    per reversed credit row.
CREATE OR REPLACE FUNCTION public.void_payment_batch(
    p_batch_id UUID,
    p_reason TEXT,
    p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
-- LOCK ORDER: tenant -> invoices (ascending id) -> payment_batches row.
DECLARE
    v_reason TEXT;
    v_batch public.payment_batches%ROWTYPE;
    v_alloc public.invoice_payment_allocations%ROWTYPE;
    v_inv public.invoices%ROWTYPE;
    v_rec RECORD;
    v_credit RECORD;
    v_ids UUID[];
    v_new_paid NUMERIC;
    v_new_status public.invoice_status;
    v_derived public.invoice_status;
    v_awaiting BOOLEAN;
    v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
    v_touched JSONB := '[]'::jsonb;
    v_src_ids UUID[];
    v_downstream UUID[] := '{}';
    v_count INT := 0;
    v_credit_total NUMERIC := 0;
    v_unapplied NUMERIC;
    v_refundable NUMERIC;
    v_payouts NUMERIC;
    v_credit_tenant UUID;
    v_lock_tenant UUID;
    v_overrides JSONB := '{}'::jsonb;
BEGIN
    IF p_reason IS NULL OR p_reason !~ '[^[:space:]]' THEN
        RAISE EXCEPTION 'A reason is required to void a payment';
    END IF;
    v_reason := regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g');

    -- Unlocked read only to learn which tenant/invoices to lock.
    SELECT * INTO v_batch FROM public.payment_batches WHERE id = p_batch_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment batch not found';
    END IF;

    -- 1. tenant
    v_lock_tenant := COALESCE(v_batch.tenant_id,
        (SELECT tenant_id FROM public.invoices WHERE id = v_batch.trigger_invoice_id));
    IF v_lock_tenant IS NOT NULL THEN
        PERFORM 1 FROM public.tenants WHERE id = v_lock_tenant FOR UPDATE;
    END IF;

    -- 2. invoices this batch paid, ascending id, before reading balances.
    SELECT array_agg(DISTINCT invoice_id ORDER BY invoice_id) INTO v_ids
    FROM public.invoice_payment_allocations
    WHERE payment_batch_id = p_batch_id AND reverses_allocation_id IS NULL AND amount > 0;
    v_src_ids := COALESCE(v_ids, '{}');
    SELECT array_agg(x ORDER BY x) INTO v_ids FROM (
        SELECT unnest(v_src_ids) AS x UNION SELECT unnest(public.money_downstream_ids(v_src_ids))
    ) q;
    PERFORM 1 FROM public.invoices WHERE id = ANY(COALESCE(v_ids, '{}')) ORDER BY id FOR UPDATE;
    IF NOT (public.money_downstream_ids(v_src_ids) <@ COALESCE(v_ids, '{}')) THEN
        RAISE EXCEPTION 'STALE_CHAIN carry-forward links changed while locking; retry';
    END IF;

    -- 3. the batch row itself; re-read under the lock.
    SELECT * INTO v_batch FROM public.payment_batches WHERE id = p_batch_id FOR UPDATE;
    IF v_batch.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'Payment batch already voided';
    END IF;

    -- Settlement / non-cash credit receipts are not voidable here (finding 141).
    IF COALESCE(v_batch.mode, '') = 'credit'
       OR COALESCE(v_batch.idempotency_key, '') LIKE 'settle:%'
       OR EXISTS (SELECT 1 FROM public.tenant_credits c
                  WHERE c.payment_batch_id = p_batch_id AND c.kind = 'applied_to_invoice') THEN
        RAISE EXCEPTION 'VOID_NOT_ALLOWED payment batch % is a move-out settlement / credit receipt (mode %, key %); it cannot be voided on its own because the held credit it applied would stay spent',
            p_batch_id, COALESCE(v_batch.mode, 'NULL'), COALESCE(v_batch.idempotency_key, 'NULL');
    END IF;

    -- Check phase: nothing below may go negative.
    FOR v_rec IN
        SELECT a.invoice_id, SUM(a.amount) AS amount
        FROM public.invoice_payment_allocations a
        WHERE a.payment_batch_id = p_batch_id AND a.reverses_allocation_id IS NULL AND a.amount > 0
        GROUP BY a.invoice_id ORDER BY a.invoice_id
    LOOP
        SELECT * INTO v_inv FROM public.invoices WHERE id = v_rec.invoice_id;
        IF COALESCE(v_inv.paid_amount, 0) - v_rec.amount < 0 THEN
            RAISE EXCEPTION 'VOID_WOULD_MAKE_NEGATIVE invoice % has paid_amount % but this receipt allocated % to it; correct the invoice before voiding',
                v_rec.invoice_id, COALESCE(v_inv.paid_amount, 0), v_rec.amount;
        END IF;
    END LOOP;

    -- New paid amounts of every touched invoice, so carried-in status checks see the post-void state.
    SELECT COALESCE(jsonb_object_agg(i.id::text, COALESCE(i.paid_amount, 0) - x.amount), '{}'::jsonb)
      INTO v_overrides
    FROM (SELECT invoice_id, SUM(amount) AS amount FROM public.invoice_payment_allocations
          WHERE payment_batch_id = p_batch_id AND reverses_allocation_id IS NULL AND amount > 0
          GROUP BY invoice_id) x
    JOIN public.invoices i ON i.id = x.invoice_id;

    SELECT COALESCE(SUM(c.amount), 0), MIN(c.tenant_id::text)::uuid INTO v_credit_total, v_credit_tenant
    FROM public.tenant_credits c
    WHERE c.payment_batch_id = p_batch_id AND c.kind = 'overpayment'
      AND NOT EXISTS (SELECT 1 FROM public.tenant_credits r WHERE r.reverses_credit_id = c.id);
    IF v_credit_total > 0 THEN
        -- The tenant was locked first; a credit row for another tenant would
        -- need a second tenant lock after the invoices (order violation) and
        -- cannot come from record_payment_batch, so refuse it.
        IF v_credit_tenant IS DISTINCT FROM v_lock_tenant THEN
            RAISE EXCEPTION 'VOID_NOT_ALLOWED overpayment credit of batch % belongs to tenant %, not the batch tenant %',
                p_batch_id, v_credit_tenant, v_lock_tenant;
        END IF;
        SELECT COALESCE(SUM(amount), 0) INTO v_unapplied
        FROM public.tenant_credits WHERE tenant_id = v_credit_tenant AND bucket = 'unapplied';
        IF v_unapplied - v_credit_total < 0 THEN
            RAISE EXCEPTION 'VOID_CREDIT_ALREADY_USED this receipt left % as tenant credit but only % unapplied credit remains; reverse the credit use first',
                v_credit_total, v_unapplied;
        END IF;
        -- Finding 142: credit already paid out as a refund is spent too.
        SELECT COALESCE(SUM(amount), 0) INTO v_refundable
        FROM public.tenant_credits
        WHERE tenant_id = v_credit_tenant AND bucket IN ('deposit', 'unapplied') AND kind <> 'refunded';
        SELECT COALESCE(SUM(amount), 0) INTO v_payouts
        FROM public.refund_payouts WHERE tenant_id = v_credit_tenant AND voided_at IS NULL;
        IF v_refundable - v_payouts - v_credit_total < 0 THEN
            RAISE EXCEPTION 'VOID_CREDIT_ALREADY_USED this receipt left % as tenant credit but % has already been refunded (refundable credit %); void the refund payout first',
                v_credit_total, v_payouts, v_refundable;
        END IF;
    END IF;

    -- Write phase.
    FOR v_alloc IN
        SELECT * FROM public.invoice_payment_allocations
        WHERE payment_batch_id = p_batch_id
          AND reverses_allocation_id IS NULL
          AND amount > 0
        ORDER BY invoice_id, created_at, id
    LOOP
        INSERT INTO public.invoice_payment_allocations (
            payment_batch_id, trigger_invoice_id, invoice_id, amount, paid_at,
            slip_url, source, payment_method_id, payment_method_snapshot,
            reverses_allocation_id, reversed_at, reversal_reason
        ) VALUES (
            v_alloc.payment_batch_id, v_alloc.trigger_invoice_id, v_alloc.invoice_id,
            -v_alloc.amount, v_alloc.paid_at,
            v_alloc.slip_url, 'void', v_alloc.payment_method_id, v_alloc.payment_method_snapshot,
            v_alloc.id, now(), v_reason
        );
        v_count := v_count + 1;
    END LOOP;

    FOR v_rec IN
        SELECT a.invoice_id, SUM(a.amount) AS amount
        FROM public.invoice_payment_allocations a
        WHERE a.payment_batch_id = p_batch_id AND a.reverses_allocation_id IS NULL AND a.amount > 0
        GROUP BY a.invoice_id ORDER BY a.invoice_id
    LOOP
        SELECT * INTO v_inv FROM public.invoices WHERE id = v_rec.invoice_id;
        v_new_paid := COALESCE(v_inv.paid_amount, 0) - v_rec.amount;
        v_derived := public.money_derive_invoice_status_cf(v_inv.id, v_inv.total_amount, v_new_paid, v_inv.due_date, v_today, v_overrides);
        v_awaiting := v_inv.status = 'verifying'
            AND COALESCE(btrim(v_inv.slip_url), '') <> ''
            AND (v_batch.slip_url IS NULL OR v_inv.slip_url <> v_batch.slip_url);

        v_new_status := CASE
            WHEN v_inv.status IN ('cancelled', 'draft') THEN v_inv.status
            WHEN v_inv.status = 'verifying' AND v_awaiting THEN v_inv.status
            WHEN v_inv.status IN ('paid', 'partial', 'verifying') THEN v_derived
            ELSE v_inv.status
        END;

        UPDATE public.invoices
        SET paid_amount = v_new_paid,
            status = v_new_status,
            -- Finding 147: leaving 'paid' clears the late-fee freeze.
            locked_late_fee_amount = CASE WHEN v_inv.status = 'paid' AND v_new_status <> 'paid'
                                          THEN NULL ELSE locked_late_fee_amount END,
            payment_history = COALESCE(payment_history, '[]'::jsonb) || jsonb_build_array(
                jsonb_build_object(
                    'type', 'void',
                    'payment_batch_id', p_batch_id,
                    'amount', -v_rec.amount,
                    'reason', v_reason,
                    'voided_at', now()
                )
            )
        WHERE id = v_rec.invoice_id;

        INSERT INTO public.money_events (
            action, actor_user_id, tenant_id, invoice_id, payment_batch_id,
            before, after, reason, source
        ) VALUES (
            'payment.void', p_actor, COALESCE(v_inv.tenant_id, v_batch.tenant_id), v_rec.invoice_id, p_batch_id,
            jsonb_build_object('paid_amount', v_inv.paid_amount, 'status', v_inv.status, 'allocation_amount', v_rec.amount,
                               'locked_late_fee_amount', v_inv.locked_late_fee_amount),
            jsonb_build_object('paid_amount', v_new_paid, 'status', v_new_status,
                               'locked_late_fee_cleared', v_inv.status = 'paid' AND v_new_status <> 'paid',
                               'status_kept', v_new_status = v_inv.status AND v_inv.status IN ('cancelled', 'draft', 'verifying')),
            v_reason, 'void_payment_batch'
        );

        v_touched := v_touched || to_jsonb(v_rec.invoice_id);
    END LOOP;
    v_downstream := public.money_rederive_downstream(v_src_ids, v_overrides, v_today, p_batch_id, p_actor, v_lock_tenant, 'void_payment_batch');

    FOR v_credit IN
        SELECT c.* FROM public.tenant_credits c
        WHERE c.payment_batch_id = p_batch_id AND c.kind = 'overpayment'
          AND NOT EXISTS (SELECT 1 FROM public.tenant_credits r WHERE r.reverses_credit_id = c.id)
        ORDER BY c.created_at, c.id
    LOOP
        INSERT INTO public.tenant_credits (
            tenant_id, kind, bucket, amount, invoice_id, payment_batch_id, reason, actor, reverses_credit_id
        ) VALUES (
            v_credit.tenant_id, 'reversal', v_credit.bucket, -v_credit.amount, v_credit.invoice_id,
            p_batch_id, 'Payment voided: ' || v_reason, p_actor, v_credit.id
        );
        INSERT INTO public.money_events (
            action, actor_user_id, tenant_id, payment_batch_id, before, after, reason, source
        ) VALUES (
            'credit.reversal', p_actor, v_credit.tenant_id, p_batch_id,
            jsonb_build_object('credit_id', v_credit.id, 'kind', v_credit.kind, 'amount', v_credit.amount),
            jsonb_build_object('reversal_amount', -v_credit.amount),
            v_reason, 'void_payment_batch'
        );
    END LOOP;

    UPDATE public.payment_batches
    SET voided_at = now(), voided_by = p_actor, void_reason = v_reason
    WHERE id = p_batch_id;

    RETURN jsonb_build_object('voided', true, 'reversed_allocations', v_count,
                              'touched_invoice_ids', v_touched, 'credit_reversed', v_credit_total,
                              'downstream_updated', to_jsonb(v_downstream));
END;
$$;

COMMENT ON FUNCTION public.void_payment_batch(UUID, TEXT, TEXT) IS
    'Atomically reverses a receipt: appends negative allocation rows, lowers invoices.paid_amount (never below 0), reverses its overpayment credit, logs money_events. Never deletes the receipt or its allocations.';

-- Server-only (service-role key); not reachable by anon/authenticated via /rpc.
REVOKE ALL ON FUNCTION public.void_payment_batch(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.void_payment_batch(UUID, TEXT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_payment_batch(UUID, TEXT, TEXT) TO service_role;

RESET lock_timeout;
