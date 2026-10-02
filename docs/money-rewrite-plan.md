# Money-system rewrite — safe execution plan

Goal: rewrite the money core behind the SAME endpoints (URLs, action names, response shapes),
one action at a time, with the old code as fallback until each new action is proven.

## Safety rules
1. Production = Supabase project `ApartmentFlow` (hunofnfolufasvsmcwby). `.env.local` points at it.
   Never run the dev server, tests with DB access, or scripts against it for write testing.
2. Migrations are files only. They are applied to production one at a time, after a backup and
   after the owner approves that specific file. Additive only (new tables/columns/functions).
3. No existing financial row is edited. Backfills are separate files, run only after review.
4. Test database = a separate Supabase project restored from a dump (owner creates the empty
   project; never use `BuildFlow Pro`, it belongs to another app).
5. Each action switches to the new core behind a flag/constant; old path stays until proven.

## Order
1. Characterization tests: pin down current behaviour of pure functions (totals, proration,
   late fee, allocation planning) so the rewrite cannot silently lose old fixes.
2. New core in `lib/money/` (pure logic first, DB adapters second).
3. Switch actions in this order (lowest risk first): void_payment (done) -> record_payment ->
   record_split_payment -> update_status -> save_details -> decline/approve slip ->
   late fees -> move-out/deposits/refunds -> points.
4. Reconciliation report and admin views.
5. Delete replaced old code. Operator guide.
