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

## Progress checklist (updated 2026-10-03, after `d9923d7`)

Legend: [x] done, tested and on main; [O] reserved for Opus (atomic DB functions, move-out settlement); [ ] not started or partial (noted). **Nothing is applied to production.** Tests: about 346 cases in 28 files by grep count (3 todo); run `npx vitest run` for the real result. Findings: 88 entries in `docs/money-system-findings.md`.

- Phase 1 - Money model
  - [x] Void/reversal model, `money_events` audit log, lifecycle document (docs/MONEY-LIFECYCLE.md)
  - [x] Adjustments, tenant credits, refund payouts, late-fee tables as migration files (tested on dorm-test)
  - [ ] Adjustments term in `computeInvoiceTotal`; writers for adjustments, refund payouts, late-fee charges (findings 12, 45)
- Phase 2 - Close bypasses
  - [x] Void replaces delete; raw money edits blocked; status/edit/delete log and refuse unsafe deletes
  - [x] LIFF "paid" with no money rejected; `save_details` whitelisted; audit logging for remaining money writes (period sync, generation, slip events)
  - [ ] Still unlogged or open: `sync_overdue`, points revert snapshot, slip-decline internals (60, 82); `record_payment` still accepts `payment_history` (57); web-admin `update_status` accepts `paid` as a label (61); `sync_period_statuses` writes on read (83)
- Phase 3 - Payments
  - [x] Allocation planner (not wired); atomic void; `record_payment` and split payment on `record_payment_batch`
  - [O] Review/fix of the atomic functions (tenant check, history guard, rounding, void reverses overpayment credit)
  - [x] Slip states and badge; LINE slip approval records the confirmed amount and date; slip events logged
  - [ ] LIFF `approve_paid` skips the slip guard when the chain is already settled (76); replaced slips not archived (78)
- Phase 4 - Late fees
  - [x] Versioned estimate engine; posted-fee and policy tables (files); estimate vs charged shown in tenant statement and action queue
  - [O] Post/waive atomic functions
  - [ ] Posting/approval flow and admin display of posted fees
- Phase 5 - Deposits, move-out, refunds
  - [x] Settlement planner (pure); refund payout table (file)
  - [O] Atomic final settlement and move-out wiring
- Phase 6 - Points
  - [x] Redemption/reversal planner
  - [O] Atomic redemption and paired reversal
- Phase 7 - Screens
  - [x] Admin reconciliation review; admin action queue; admin invoice Payments tab (ledger view, voids, discrepancy notice); tenant statement; deep links; nav gating by permission
  - [x] Statement on payment link pages and LIFF invoice list (pending invoices); receipts show reversals
  - [ ] Statement for paid invoices and as the single balance on tenant pages (53, 54, 74); refund due vs paid view; several nav items still ungated (80)
- Phase 8 - Reports and reconciliation
  - [x] Report-only checks with CSV; review page
  - [x] Cash vs billing definitions and labels; Reports toggle; web dashboard and daily digest read receipts; non-cash separated from cash totals
  - [ ] LINE admin dashboard still on old figure (68); dashboard collected-vs-outstanding bar mixes bases (67)
- Phase 9 - Delivery
  - [x] Test project dorm-test (gaps in `docs/TEST-SCHEMA-GAPS.md`); findings report; scenario suite; operator guide; audit brief; read-only discrepancy report tool (`scripts/discrepancy-report.ts`); docs index `docs/README-money.md`
  - [ ] Production schema export and diff against dorm-test; run discrepancy report on real data (owner); Opus review; production go-live (backup, migrations one at a time, then code) - see `docs/README-money.md`
