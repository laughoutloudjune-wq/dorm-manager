-- Carry-forward link repair.
--
-- `invoice_carry_forwards` is the only table that records which invoice carried
-- which earlier invoice forward. Every writer upserts with
-- `onConflict: "source_invoice_id,target_invoice_id"`, but the live database
-- still carried the original `UNIQUE (source_invoice_id)` constraint from
-- final-schema.sql — 20260629000001 was written but never applied. Postgres
-- rejects an ON CONFLICT clause with no matching constraint, and the
-- generate-invoices path only reports that error to `setError`, so the links
-- were silently dropped: 9 of 17 carry-forward relationships had no row.
--
-- Without the link row, `applyInvoicePaymentAllocation` cannot see that two
-- invoices are connected, so a payment on the newer bill never reaches the
-- older one it carried.
--
-- Step 1 replaces the constraint (idempotent — safe if 20260629000001 did land).
-- Step 2 rebuilds the missing rows from `additional_fees_breakdown`, which
-- already stores `source_invoice_id` and the amount for every carried line.
-- No amounts are recalculated: this only restores pointers.

BEGIN;

-- 1. One link per (source, target) instead of one link per source. A bill that
--    stays unpaid for three months is legitimately carried into three later
--    invoices — room 114/1's April bill is the source for May, June and July.
ALTER TABLE public.invoice_carry_forwards
  DROP CONSTRAINT IF EXISTS invoice_carry_forwards_source_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoice_carry_forwards_source_target_unique'
      AND conrelid = 'public.invoice_carry_forwards'::regclass
  ) THEN
    ALTER TABLE public.invoice_carry_forwards
      ADD CONSTRAINT invoice_carry_forwards_source_target_unique
      UNIQUE (source_invoice_id, target_invoice_id);
  END IF;
END $$;

-- 2. Rebuild the links the failed upserts never wrote.
INSERT INTO public.invoice_carry_forwards (source_invoice_id, target_invoice_id, amount)
SELECT
  (item ->> 'source_invoice_id')::uuid AS source_invoice_id,
  target.id                            AS target_invoice_id,
  SUM(
    COALESCE(
      NULLIF(item ->> 'total_amount', '')::numeric,
      NULLIF(item ->> 'amount', '')::numeric,
      0
    )
  )                                    AS amount
FROM public.invoices AS target
CROSS JOIN LATERAL jsonb_array_elements(
  COALESCE(target.additional_fees_breakdown, '[]'::jsonb)
) AS item
WHERE item ->> 'item_type' = 'carry_forward'
  AND COALESCE(item ->> 'source_invoice_id', '') <> ''
  -- Skip orphans: a deleted source would fail the foreign key.
  AND EXISTS (
    SELECT 1
    FROM public.invoices AS source
    WHERE source.id = (item ->> 'source_invoice_id')::uuid
  )
GROUP BY (item ->> 'source_invoice_id')::uuid, target.id
ON CONFLICT (source_invoice_id, target_invoice_id) DO NOTHING;

COMMIT;
