-- Hardening: take away the default table privileges that Supabase grants to the public API roles
-- (anon, authenticated) on the NEW money tables and views.
--
-- ADDITIVE / SAFE: only REVOKEs on objects created by 0100-0650. Row-level security already blocks these roles
-- (RLS is on, no policy), and the app uses the service-role key, so nothing in the app changes. This makes the new
-- tables match the existing money tables (invoices, payment_batches, ...), which carry no anon/authenticated privileges.
--
-- Found on 2026-10-10 while applying the migrations to production: the new tables inherited the Supabase default
-- grants (ALL to anon and authenticated). Idempotent: re-running does nothing.
--
-- No rollback needed; re-granting would only re-open privileges that RLS blocks anyway.

REVOKE ALL ON public.adjustments, public.late_fee_charges, public.late_fee_policies, public.move_out_settlements,
              public.refund_payouts, public.tenant_credits, public.refund_due_vs_paid, public.tenant_credit_balances
    FROM anon, authenticated;
-- money_events already carries no such grants in production; revoke anyway so a database built from the repo files matches.
REVOKE ALL ON public.money_events FROM anon, authenticated;
