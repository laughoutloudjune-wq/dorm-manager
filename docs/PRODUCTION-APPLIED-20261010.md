# Production database: migrations applied (2026-10-10)

Project `ApartmentFlow` (`hunofnfolufasvsmcwby`). Applied by Claude on the owner's explicit "go", through the Supabase connector, after a read-only precheck. **Only the database was changed. The app has NOT been deployed.**

## What was done, in order
1. **Read-only precheck** (see `docs/PRODUCTION-PRECHECKS.sql`). Result: row-level security on for all 13 existing money tables, no anon/authenticated write privileges, none of the new functions or tables present, every prerequisite column present (`room_logs`, `user_roles`, `late_fee_billed_at`, `notice_date`...), production's own `money_events` table already existed with identical columns and 0 rows, invoice statuses all standard, point reasons all allowed.
2. **Snapshot** (free tier has no automatic backup). 12 copies named `pre_money_20261010_<table>` in the `public` schema: `invoices`, `payment_batches`, `invoice_payment_allocations`, `invoice_carry_forwards`, `tenants`, `rooms`, `room_tenant_logs`, `move_out_requests`, `point_ledger_entries`, `payment_methods`, `settings`, `money_events`. Row counts and a content hash matched the originals; RLS on; no public privileges. They live in the same database: they protect against a wrong change to rows, not against losing the database. **Keep them until the new system has run cleanly for a while, then drop them deliberately.**
3. **Fingerprint of existing data** taken before and after: invoices 589 (total 2,240,388.00, paid 1,933,670.00), payment_batches 513 (1,882,768.00), allocations 520 (1,882,768.00), tenants 98, carry-forward links 22 (59,006.00), point entries 225, each with a content hash. After all migrations every value and hash was identical. The new tables hold 0 rows.
4. **Migrations applied, one at a time, each verified**: `20261002000000`, `0100`, `0200`, `0300`, `0400`, `0500`, `0600` (two parts), `0650`, `0700` (two parts), `0800`. `0900` (test-only) was NOT applied. After each file the function bodies were compared with the file by hash (comments and whitespace removed): all 22 functions match their files exactly. Header comment blocks and rollback comments were not pasted (no executable difference).
5. **Extra hardening** (`20261002000850_migration-revoke-public-table-grants.sql`, new file in this repo): the new tables and views had inherited Supabase's default privileges for `anon`/`authenticated`. RLS blocked them anyway; they were revoked to match the existing tables. Verified: 0 public privileges left on any money table, view or snapshot.
6. **Final checks**: no function executable by `anon` or `authenticated` (22 of 22), all 7 append-only/guard triggers present, both views `security_invoker`, `point_ledger_entries` constraints validated, `adjustments_type_check` now includes `points_redemption`.

## Security advisor after the change (Supabase)
- 50 INFO "RLS enabled, no policy": expected; these tables are server-key only.
- 6 WARN "function search_path mutable": the six append-only guard trigger functions (`*_block_mutation`, `refund_payouts_guard`, `move_out_settlements_guard`). They only raise an error and read no objects; harmless. A later hardening can pin a search path.
- 1 WARN "leaked password protection disabled": a Supabase Auth dashboard setting, not part of this work.

## Not done yet
- **Deploy the app.** The database now has the new tables and functions, but the running app does not call them yet. Existing flows keep working because the new objects are additive; the new screens and the atomic payment/settlement paths only exist once the new app is deployed. Do the deploy soon: old app code that writes `payment_batches` or allocations directly should keep working (only UPDATE/DELETE on money_events, tenant_credits, etc. is blocked, and the old app never touched those).
- After deploying: the post-deploy checks in `docs/GO-LIVE.md` step 3, and one real LINE payment.
- Optional: export CSV copies of the key tables from the dashboard as an off-database backup.

## If something is wrong
- Do not drop the new tables or run rollback notes from file headers (they delete audit data).
- Existing rows can be compared with, or restored from, the `pre_money_20261010_*` snapshots. Ask Claude before restoring anything.
- Reverting only the app (previous deployment) is safe at any time.
