-- Adds meter-reading snapshot columns to invoices.
--
-- final_move_out (app/api/admin/tenants/actions/route.ts) has always written these
-- four fields on the settlement invoice it creates, and MoveOutProcessingModal.tsx
-- has always read electricity_reading_end/water_reading_end back from the tenant's
-- most recent invoice to pre-fill "previous reading" on a repeat move-out. Neither
-- column ever existed on this table, so the write silently failed once it got far
-- enough to reach it, and the read always fell back to the tenant's original
-- initial reading instead of the more accurate per-invoice snapshot.
ALTER TABLE public.invoices
ADD COLUMN IF NOT EXISTS electricity_reading_start NUMERIC(10, 2),
ADD COLUMN IF NOT EXISTS electricity_reading_end NUMERIC(10, 2),
ADD COLUMN IF NOT EXISTS water_reading_start NUMERIC(10, 2),
ADD COLUMN IF NOT EXISTS water_reading_end NUMERIC(10, 2);
