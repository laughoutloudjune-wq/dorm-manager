# Audit brief for an external reviewer

You are reviewing the money-handling changes of a small property-management system. You can read this repository. Please produce a findings report in the format at the end.

## Hard rules for you
- **Do NOT open, print, quote or search inside `.env.local`** (or any `.env*` file). It contains live production credentials. Review code and migrations only.
- Do not run anything against a database. Production is the Supabase project `ApartmentFlow`; nothing in this review needs a connection. The migrations are files that have NOT been applied to production.
- Do not propose "repair scripts" that auto-edit historical rows. Findings and suggested code or SQL fixes only.

## 1. What the system is
`dorm-manager`: Next.js + Supabase app for a dorm/apartment business in Thailand (currency baht). An admin web dashboard (`app/(admin)/*`) and tenant LINE mini-apps (`app/(public)/*`, `app/api/payment-liff/*`, `app/api/admin-liff/*`). Server routes use the Supabase service-role key (RLS is bypassed), so correctness is enforced in code and in SQL functions. Read `CLAUDE.md` first: it explains invoice lifecycle, late fees, carry-forward, proration and a past incident (about 150,000 baht of fake receipts created by a status change).

## 2. The money rules (what must hold)
1. Money is a **receipt** (`payment_batches`) split into **allocations** (`invoice_payment_allocations`). These are the authority for cash received. `invoices.paid_amount` is a running balance and `invoices.payment_history` (JSON) is a display cache only.
2. An invoice total is computed only by `computeInvoiceTotal` in `lib/invoice-total.ts`. No other code may add charges.
3. Changing status never moves money. Money is recorded only by `record_payment`, `record_split_payment`, and LINE `approve_paid`.
4. No receipt or allocation is edited or deleted. A mistake is **voided**: negative reversing allocations are appended (`reverses_allocation_id`), the batch is stamped voided. Then the right payment is re-recorded.
5. Receiving account is frozen in `payment_method_snapshot` at payment time and never re-derived.
6. Non-cash settlement (deposit/advance credit, points, write-off) is never cash received.
7. Overpayment is kept as a tenant credit, never dropped and never over-allocated.
8. Every money-affecting action writes an append-only `money_events` row.
9. Retried requests must not double-record (idempotency key per `(trigger_invoice_id, idempotency_key)`).
Full model and implemented-vs-planned status: `docs/MONEY-LIFECYCLE.md`. Owner-facing behaviour: `docs/OPERATOR-GUIDE.md`.

## 3. Commit range
Baseline before this work: `22b5c7a`. Work: `22b5c7a..main` (22 commits, 36 files, about +3,983/-523 lines at time of writing). First commit of the work: `b48d318` ("append-only payment void, money_events audit log, block raw money writes"). Use:
```
git log --oneline 22b5c7a..main
git diff 22b5c7a main -- app lib supabase components
```
Some commits are merges of parallel agent branches; read the diff, not just messages.

## 4. Where each phase lives (see `docs/money-rewrite-plan.md` for the checklist)
- Phase 1, model and audit log: `supabase/migrations/20261002000000_*` (money_events, void_payment_batch, void columns), `...000100` adjustments, `...000200` tenant_credits and view, `...000300` refund_payouts and view, `...000400` late_fee_charges/policies; `lib/money-events.ts`; `lib/invoice-total.ts`; `docs/MONEY-LIFECYCLE.md`.
- Phase 2, bypass closing: `app/api/admin/invoices/actions/route.ts` (`update_status`, `save_details`, `record_payment`, `delete_many`, `void_payment`), `app/api/admin-liff/invoices/actions/route.ts`, `lib/money/money-diff.ts`, `lib/hooks/use-invoices-state.ts`, `components/admin/invoices/InvoiceDetailModal.tsx`.
- Phase 3, payments: `supabase/migrations/20261002000500_*` (`record_payment_batch`), `lib/invoice-ledger.ts` (`applyInvoicePaymentAllocation`, `applyManualInvoicePaymentAllocation`), `lib/money/allocation.ts` (planner, not yet called by routes), `lib/money/manual-split-payload.ts`.
- Phase 4, late fees: `lib/money/late-fee.ts`, migration `...000400` (not wired; live logic is `calculateLateFeeAmount` in `lib/invoice-ledger.ts`).
- Phase 5, deposits/move-out/refunds: `lib/money/settlement.ts` (not wired), migrations `...000200` and `...000300`; live move-out code in `app/api/admin/tenants/actions/route.ts`.
- Phase 6, points: `lib/money/points-redemption.ts` (not wired); live code `lib/points-ledger.ts`.
- Phase 8, reconciliation: `lib/money/reconciliation-checks.ts`, `lib/money/reconciliation-view.ts`, `app/api/admin/reconciliation/route.ts`, `app/(admin)/reconciliation/page.tsx`.
- Tests: `lib/money/*.test.ts`, `lib/invoice-ledger-manual-split.test.ts`, plus older `lib/*.test.ts`.
- Findings so far (42 entries): `docs/money-system-findings.md`. Reserved-for-Opus list: `docs/OPUS-HANDOFF.md`.

## 5. How to run checks
```
npm install
npx vitest run
npx tsc --noEmit -p .
```
Neither needs database access. There are no automated tests for API routes or SQL functions; SQL was verified only by hand with rollback-wrapped scenarios on a dummy project (`dorm-test`), so SQL review is by reading.

## 6. Known gaps (do not report as new; do tell us if you disagree with the assessment)
- No migration is applied to production. `supabase/migrations/final-schema.sql` is stale, so a database cannot be rebuilt from the repo; column names used in reconciliation are assumed (findings 9, 16, 41).
- Adjustments are not part of `computeInvoiceTotal` yet (finding 12); tables for adjustments, credits, refunds and late-fee charges have no writers.
- `record_payment_batch`: tenant-ownership check of invoices, stale check also over `payment_history`, and 2-decimal rounding on the auto path are open (findings 34-36).
- `void_payment_batch` does not reverse an overpayment credit made by the same batch.
- Non-cash credit payments (`abandon_room`) are real receipt rows and still appear in the Reports cash view with only a note.
- `save_details` accepts arbitrary payloads (audit-logged) and nulls `locked_late_fee_amount` in one case (findings 29-31). LIFF `update_status` accepts `paid` without a slip (28). LINE `approve_paid` passes `Number.MAX_SAFE_INTEGER` as the amount (26).
- Points redemption is non-atomic and hard-deletes on reversal (20-25).
- Move-out settlement planner exists but the live move-out routes do not use it.
- No locking or atomicity in several legacy paths. The atomic functions for settlement, points and late-fee posting are intentionally unwritten (reserved for a later review).

## 7. Review questions
A. Ways money can be lost, duplicated or double-counted:
 - Any path where a receipt, allocation or invoice amount is written without a matching counterpart (batch without allocations, allocation without batch, `paid_amount` without allocations).
 - Void then re-record: can a voided receipt still be counted anywhere (reports, dashboard, points, carry-forward, late-fee freeze)? Are reversal rows excluded or netted consistently? Can an overpayment credit survive a void?
 - Idempotency: can the same payment replay create a second batch, or a replay return a result inconsistent with the first? Is the idempotency key scope right across the manual split path (trigger invoice choice)?
 - Double counting of late fees across `late_fee_amount` and `additional_fees_total`; discount applied twice; carry-forward amounts counted in both source and target.
 - Non-cash credits counted as cash in any report, per-account breakdown, or dashboard.
B. Race conditions in the SQL functions (`record_payment_batch`, `void_payment_batch`): lock order and deadlocks across multiple invoices, the check-then-insert for idempotency, the `STALE_INVOICE` guard coverage, concurrent void and record on the same invoice, the lack of `SECURITY` and `search_path` settings, enum casts, rounding (`numeric` versus floats from JSON).
C. Mismatches between SQL and TypeScript: status transitions computed in TS versus SQL (void downgrade rule), what TS expects back from the RPC versus what SQL returns, allocation rounding, column names in reconciliation versus real tables, `payment_history` shape written by SQL versus read by TS.
D. Places still writing `paid_amount`, `total_amount`, `status`, `locked_late_fee_amount` or `payment_history` directly rather than through the engine or the SQL functions: search `app/` and `lib/` for `.update(` and `.insert(` on `invoices`, `payment_batches`, `invoice_payment_allocations`. Include LIFF routes, cron routes, move-out and transfer flows, points sync, `sync_*` actions, and `delete_many`.
E. Authorisation: permission keys per action (`lib/permissions.ts`), routes missing `requireAdminPermission`, tenant routes relying on a LINE token.
F. Anything in the migrations that could harm production data if applied (they are meant to be additive only).

## 8. Output format wanted
Findings grouped by severity (Critical, High, Medium, Low, Info). For each:
- ID and one-line title
- Location as `path:line` (plus function name)
- What can go wrong, with a concrete scenario and amounts if possible
- Confidence (certain / likely / needs data)
- Suggested fix (code or SQL sketch, additive where possible)
Then: a short list of things you verified are correct, and any assumption you could not check because the real production schema is not in the repo.
