-- Phase 0 C1: lock the anon role out of every application table. Nothing
-- legitimate uses anon for direct table access any more -- every
-- tenant-facing and public flow now goes through a server route with the
-- service-role key (docs/audit/2026-09-29-system-audit-detailed.md finding
-- C1). authenticated keeps a temporary permissive policy below: a few
-- admin components (ReportsPageView.tsx, MoveOutProcessingModal.tsx, and 3
-- remaining reads in app/(admin)/settings/page.tsx) still read directly
-- from the browser as an authenticated admin session and have not been
-- migrated to a server route yet -- narrowing authenticated's access before
-- those are moved would break the Reports page and move-out settlement
-- flow outright. This is intentionally not the final state; see the
-- migration name for what still needs to happen.

-- Backup tables: nothing in the live app reads these; lock to service-role
-- only, no policy for anyone else.
ALTER TABLE public.invoices_money_backup_20260820 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_batches_backup_20260820 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_payment_allocations_backup_20260820 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realloc_backup_212_2_20260821 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realloc_backup_212_2_allocs_20260821 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoices_money_backup_20260820 FROM anon, authenticated;
REVOKE ALL ON public.payment_batches_backup_20260820 FROM anon, authenticated;
REVOKE ALL ON public.invoice_payment_allocations_backup_20260820 FROM anon, authenticated;
REVOKE ALL ON public.realloc_backup_212_2_20260821 FROM anon, authenticated;
REVOKE ALL ON public.realloc_backup_212_2_allocs_20260821 FROM anon, authenticated;

-- Already RLS-enabled with zero policies (already denying everyone) --
-- just strip its stale grants too.
REVOKE ALL ON public.room_takeover_requests FROM anon, authenticated;

-- The 20 normal application tables: RLS on, anon fully revoked,
-- authenticated keeps working exactly as before via an explicit permissive
-- policy (temporary -- see note above).
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'buildings','invoice_arrears_snapshots','invoice_carry_forwards',
    'invoice_payment_allocations','invoices','line_meter_users',
    'meter_readings','move_out_requests','payment_batches',
    'payment_methods','point_ledger_entries','receipt_profiles',
    'room_logs','room_tenant_logs','rooms','settings',
    'tenant_referrals','tenant_room_transfers','tenants','user_roles'
  ])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format(
      'CREATE POLICY authenticated_full_access_temp ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)', t
    );
  END LOOP;
END $$;
