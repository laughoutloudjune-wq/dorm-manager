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

## Progress checklist (updated 2026-10-02)

Legend: [x] done and tested, [~] partly done, [ ] not started. Nothing below has been applied to production.

- [~] Phase 1 — Canonical money model
  - [x] Void/reversal model decided: append negative allocation rows, keep receipt
  - [x] `money_events` append-only audit log (table + `lib/money-events.ts`)
  - [ ] Write the money lifecycle document (record authority, non-cash settlement labels)
  - [ ] Tables: adjustments, tenant credits, refund payouts
- [~] Phase 2 — Close bypasses
  - [x] Payment delete replaced by void; raw money payload to `record_payment` blocked
  - [ ] `update_status` stops touching late-fee fields; log before/after
  - [ ] `save_details`, `delete_many`, tenants/admin-LIFF routes audited and logged
- [~] Phase 3 — Payment and correction workflow
  - [x] Allocation planner (oldest-first, manual split, overpayment kept as credit) — 8 tests
  - [x] Void with reason, atomic, double-void rejected — verified on test DB
  - [ ] `record_payment` / split payment switched to the planner + atomic DB function
  - [ ] Slip review states (submitted / under review / approved / partial / declined)
- [~] Phase 4 — Late fees
  - [x] Versioned-policy estimate engine (grace, flat/percent, cap, compounding, rounding, waiver) — 9 tests
  - [ ] Posted-fee charge table, approval flow, waiver events
  - [ ] Admin and tenant display; read-only comparison before applying a new policy
- [ ] Phase 5 — Deposits, credits, move-out, refunds (due vs paid)
- [ ] Phase 6 — Points and discounts (atomic redemption and reversal)
- [ ] Phase 7 — Tenant and admin screens
- [ ] Phase 8 — Reports and reconciliation (extend `lib/reconciliation.ts`, admin review view)
- [~] Phase 9 — Historical safety and delivery
  - [x] Test project `dorm-test` created; base schema and void function applied
  - [x] Findings report started (`docs/money-system-findings.md`)
  - [ ] Production schema export (to rebuild an accurate test copy)
  - [ ] Read-only discrepancy report + CSV, proposed repair per category
  - [ ] Scenario test suite (all cases in the brief)
  - [ ] Operator guide
