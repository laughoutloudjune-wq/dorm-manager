-- ============================================================
-- MIGRATION: Fix invoice_carry_forwards unique constraint
-- Run this in Supabase SQL Editor
-- ============================================================

-- Step 1: Fix the unique constraint (one source can now link to multiple targets)
ALTER TABLE public.invoice_carry_forwards
  DROP CONSTRAINT IF EXISTS invoice_carry_forwards_source_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoice_carry_forwards_source_target_unique'
  ) THEN
    ALTER TABLE public.invoice_carry_forwards
      ADD CONSTRAINT invoice_carry_forwards_source_target_unique
      UNIQUE (source_invoice_id, target_invoice_id);
  END IF;
END $$;

-- Step 2: Repair data — sync invoice_carry_forwards from additional_fees_breakdown JSON
-- for all draft/overdue invoices that have carry_forward items in breakdown
-- but no corresponding row in the join table.
INSERT INTO public.invoice_carry_forwards (source_invoice_id, target_invoice_id, amount)
SELECT
  (item->>'source_invoice_id')::uuid AS source_invoice_id,
  inv.id AS target_invoice_id,
  (item->>'total_amount')::numeric AS amount
FROM public.invoices inv,
  jsonb_array_elements(inv.additional_fees_breakdown) AS item
WHERE
  inv.additional_fees_breakdown IS NOT NULL
  AND jsonb_array_length(inv.additional_fees_breakdown) > 0
  AND item->>'item_type' = 'carry_forward'
  AND (item->>'source_invoice_id') IS NOT NULL
  AND (item->>'source_invoice_id') != ''
ON CONFLICT (source_invoice_id, target_invoice_id)
DO UPDATE SET amount = EXCLUDED.amount;

-- Step 3: Recalculate total_amount for all draft invoices to include carry_forward
-- (fixes invoices where total_amount was saved without carry_forward by syncMonthInvoicesWithSettings)
UPDATE public.invoices
SET total_amount = (
  COALESCE(rent_amount, 0) +
  COALESCE(water_bill, 0) +
  COALESCE(electricity_bill, 0) +
  COALESCE(common_fee, 0) +
  COALESCE(additional_fees_total, 0) +
  COALESCE(late_fee_amount, 0) +
  COALESCE(carry_forward_amount, 0) -
  COALESCE(discount_amount, 0)
)
WHERE
  status = 'draft'
  AND carry_forward_amount > 0
  AND ABS(
    total_amount - (
      COALESCE(rent_amount, 0) +
      COALESCE(water_bill, 0) +
      COALESCE(electricity_bill, 0) +
      COALESCE(common_fee, 0) +
      COALESCE(additional_fees_total, 0) +
      COALESCE(late_fee_amount, 0) +
      COALESCE(carry_forward_amount, 0) -
      COALESCE(discount_amount, 0)
    )
  ) > 0.001;  -- only update if formula disagrees with stored value

-- Verify results
SELECT
  id,
  start_date,
  status,
  rent_amount,
  water_bill,
  electricity_bill,
  common_fee,
  additional_fees_total,
  late_fee_amount,
  carry_forward_amount,
  discount_amount,
  total_amount,
  (rent_amount + water_bill + electricity_bill + common_fee +
   additional_fees_total + late_fee_amount + carry_forward_amount - discount_amount) AS expected_total,
  total_amount = (rent_amount + water_bill + electricity_bill + common_fee +
   additional_fees_total + late_fee_amount + carry_forward_amount - discount_amount) AS is_consistent
FROM public.invoices
WHERE carry_forward_amount > 0
ORDER BY start_date DESC
LIMIT 20;
