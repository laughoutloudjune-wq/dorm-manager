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

## Progress checklist (updated 2026-10-02, after merging the four parallel agents)

Legend: [x] done and tested, [~] logic written and tested but not wired into routes/screens, [ ] not started.
Nothing below has been applied to production. Tests: 199 passing.

- [~] Phase 1 - Canonical money model
  - [x] Void/reversal model; `money_events` audit log
  - [x] Tables as migration files, tested on dorm-test: adjustments, tenant credits, refund payouts, late-fee charges and policies
  - [ ] Money lifecycle document (record authority, non-cash settlement labels)
  - [ ] Add an adjustments term to `computeInvoiceTotal`
- [~] Phase 2 - Close bypasses
  - [x] Payment delete replaced by void; raw money payload to `record_payment` blocked
  - [ ] `update_status` stops touching late-fee fields; before/after logging
  - [ ] `save_details`, `delete_many`, tenants and admin-LIFF routes audited and logged
- [~] Phase 3 - Payment and correction workflow
  - [x] Allocation planner (oldest-first, manual split, overpayment kept as credit)
  - [x] Atomic void, tested on dorm-test
  - [ ] `record_payment` and split payment switched to planner + atomic DB function
  - [ ] Slip review states
- [~] Phase 4 - Late fees
  - [x] Versioned-policy estimate engine
  - [x] Posted-fee and policy tables (files)
  - [ ] Approval flow, waiver events, admin and tenant display
- [~] Phase 5 - Deposits, credits, move-out, refunds
  - [x] Settlement planner (refund due vs paid, forfeiture needs a reason)
  - [x] Refund payout table (file)
  - [ ] Atomic final-settlement function; wire into move-out screens
- [~] Phase 6 - Points and discounts
  - [x] Redemption/reversal planner with shared key; discrepancy finder
  - [ ] Atomic DB function; replace non-atomic `redeemPoints` and hard-delete reversal
- [ ] Phase 7 - Tenant and admin screens
- [~] Phase 8 - Reports and reconciliation
  - [x] Report-only reconciliation checks + CSV
  - [ ] Admin review view, action queue, cash vs billing report labels, dashboard from receipts
- [~] Phase 9 - Historical safety and delivery
  - [x] Test project dorm-test; findings report (25 entries so far)
  - [ ] Production schema export to rebuild an accurate test copy
  - [ ] Read-only discrepancy report + proposed repair per category
  - [ ] Scenario test suite for every case in the brief
  - [ ] Audit brief for GPT, operator guide
