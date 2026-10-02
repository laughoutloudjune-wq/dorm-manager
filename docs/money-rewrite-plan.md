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

## Progress checklist (updated 2026-10-03)

Legend: [x] done, tested and on main; [O] reserved for Opus (atomic DB functions, move-out settlement); [ ] not started. Nothing is applied to production. Tests: 299 passing + 3 todo.

- Phase 1 - Money model
  - [x] Void/reversal model, `money_events` audit log, lifecycle document (docs/MONEY-LIFECYCLE.md)
  - [x] Adjustments, tenant credits, refund payouts, late-fee tables as migration files (tested on dorm-test)
  - [ ] Adjustments term in `computeInvoiceTotal`; writers for the new tables
- Phase 2 - Close bypasses
  - [x] Void replaces delete; raw money edits blocked; status/edit/delete log and refuse unsafe deletes
  - [x] LIFF "paid" with no money rejected; `save_details` whitelisted; extra audit logging
  - [ ] Remaining unlogged writes listed in findings 56-62
- Phase 3 - Payments
  - [x] Allocation planner; atomic void; `record_payment` and split payment on `record_payment_batch`
  - [O] Review/fix of the atomic functions (tenant check, history guard, rounding, void reverses overpayment credit)
  - [ ] Slip review states; LIFF slip approval records the confirmed amount
- Phase 4 - Late fees
  - [x] Versioned estimate engine; posted-fee and policy tables (files)
  - [O] Post/waive atomic functions
  - [ ] Admin and tenant display of estimate vs posted (tenant statement shows charged vs estimate)
- Phase 5 - Deposits, move-out, refunds
  - [x] Settlement planner (pure); refund payout table (file)
  - [O] Atomic final settlement and move-out wiring
- Phase 6 - Points
  - [x] Redemption/reversal planner
  - [O] Atomic redemption and paired reversal
- Phase 7 - Screens
  - [x] Admin reconciliation review; admin action queue; admin invoice Payments tab (ledger view, voids, discrepancy notice); tenant statement
  - [ ] Tenant LIFF invoices page uses the statement; refund due vs paid views
- Phase 8 - Reports and reconciliation
  - [x] Report-only checks with CSV; review page
  - [ ] Cash vs billing labels and dashboard from receipts (agent running)
- Phase 9 - Delivery
  - [x] Test project; findings report (66 entries); scenario suite; operator guide; audit brief
  - [ ] Production schema export; read-only discrepancy report on real data; Opus review; production go-live (backup, migrations in order, then code)
