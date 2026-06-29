-- Fix invoice_carry_forwards unique constraint
-- Old constraint: UNIQUE (source_invoice_id) — only one target per source
-- Problem: when a source like Apr-2026 is carried into May, it cannot also be
--          referenced in a later invoice (Jun) causing silent insert failures
--          and join-table drift from additional_fees_breakdown JSON.
-- New constraint: UNIQUE (source_invoice_id, target_invoice_id) — a source
--          can appear in multiple target invoices, but only once per target.

ALTER TABLE public.invoice_carry_forwards
  DROP CONSTRAINT IF EXISTS invoice_carry_forwards_source_unique;

ALTER TABLE public.invoice_carry_forwards
  ADD CONSTRAINT invoice_carry_forwards_source_target_unique
  UNIQUE (source_invoice_id, target_invoice_id);
