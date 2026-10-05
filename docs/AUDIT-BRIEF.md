# Audit brief for an external reviewer

You are reviewing the money-handling changes of a small property-management system (Next.js + Supabase, Thai baht). You can read this repository. Produce a findings report in the format at the end.

## Hard rules for you
- **Do NOT open, print, quote or search inside `.env.local`** or any `.env*` file. It holds live production credentials. Review code, migrations and docs only.
- Do not connect to any database. Production is the Supabase project `ApartmentFlow`; **nothing in this branch has been applied to it**. SQL migrations are files.
- Do not propose scripts that auto-edit historical rows. Findings and suggested code or SQL fixes only.

## 1. System
Admin web dashboard (`app/(admin)/*`) plus tenant LINE mini-apps (`app/(public)/*`, `app/api/payment-liff/*`, `app/api/admin-liff/*`). Server routes use the service-role key (RLS bypassed), so correctness lives in code and SQL functions. Read `CLAUDE.md` first, especially its last section "Money rules as implemented (October 2026)" which corrects older statements. A past incident created about 150,000 baht of fake receipts from a status change.

## 2. Rules that must hold
1. Money is a receipt (`payment_batches`) split into allocations (`invoice_payment_allocations`). `invoices.paid_amount` is a running balance; `payment_history` is a display cache.
2. Invoice totals are computed only by `computeInvoiceTotal` (`lib/invoice-total.ts`).
3. Changing status never moves money. Money is recorded only by `record_payment`, `record_split_payment`, LINE `approve_paid`, and the move-out settlement.
4. Receipts and allocations are never edited or deleted; mistakes are voided with reversing rows.
5. Receiving account is frozen in `payment_method_snapshot`.
6. Non-cash settlement (credit, points, write-off) is never cash.
7. Overpayment is kept as tenant credit.
8. Every money action writes an append-only `money_events` row.
9. Retries are idempotent (`(trigger_invoice_id, idempotency_key)`, payload hash).
10. Carry-forward rule: invoice paid iff own paid > 0 and own paid + carried-in from settled sources >= total; settled is defined recursively, with a "legacy-shaped" exception (TS `lib/money/carry-in.ts`, SQL `money_carried_in_settled`). Owed = max(0, total - carry - paid). Sums across invoices count a carried debt once.
11. Advance rent is never refundable; refund due = deposit left + unapplied credit; payouts capped at refund due.
12. Global lock order in SQL: tenant, room, invoices (ascending id), then other rows.
Model and status: `docs/MONEY-LIFECYCLE.md`. Design decisions and known limits: `docs/OPUS-HANDOFF.md` (titled "Notes for the external auditor").

## 3. Commit range
Baseline `22b5c7a`. Work: `22b5c7a..HEAD` on the feature branch (107 commits as of `ef9253d`, 154 files). Commands:
```
git log --oneline 22b5c7a..HEAD
git diff 22b5c7a HEAD -- app lib supabase components scripts
```
Some commits merge parallel agent branches; read diffs, not messages. Migrations in order: `20261002000000` (money_events, void, carry-forward helpers), `0100` adjustments, `0200` tenant_credits, `0300` refund_payouts, `0400` late-fee tables, `0500` record_payment_batch, `0600` final_settle_move_out + move_out_settlements, `0650` refund payouts and settlement reversal, `0700` points, `0800` late-fee actions. `0900` is test-project-only.

## 4. Files per phase
- **Model, audit, void, carry-forward helpers:** `supabase/migrations/20261002000000_*`, `...0100`, `...0200`, `...0300`, `...0400`; `lib/money-events.ts`; `lib/invoice-total.ts`; `lib/money/carry-in.ts`.
- **Payments and bypass closing:** `supabase/migrations/20261002000500_*`; `lib/invoice-ledger.ts` (`applyInvoicePaymentAllocation`, `applyManualInvoicePaymentAllocation`, `getChainOwnOutstanding`, `calculateLateFeeAmount`, `syncInvoiceLedger`); `app/api/admin/invoices/actions/route.ts`; `app/api/admin-liff/invoices/actions/route.ts`; `lib/money/money-diff.ts`, `save-details-guard.ts`, `payment-payload-hash.ts`, `payment-errors.ts`, `allocation.ts`, `manual-split-payload.ts`, `slip-approval.ts`, `slip-states.ts`; `lib/hooks/use-invoices-state.ts` (large-payment confirm); `components/admin/invoices/InvoiceDetailModal.tsx`; `app/api/payment-liff/submit/route.ts`.
- **Late fees:** `supabase/migrations/20261002000800_*`; `lib/money/late-fee.ts`, `late-fee-flow.ts`, `late-fee-posting.ts`; `app/api/admin/late-fees/actions/route.ts`.
- **Move-out, refunds, reversal:** `supabase/migrations/20261002000600_*`, `...000650_*`; `lib/money/settlement.ts`, `move-out-settlement-input.ts`, `refund-actions.ts`; `app/api/admin/tenants/actions/route.ts` (`move_out`, `final_move_out`, `abandon_room`); `app/api/admin/refunds/actions/route.ts`; `app/(admin)/credits-refunds/page.tsx`; `components/admin/refunds/*`; `app/api/admin/credits-refunds/route.ts`.
- **Points:** `supabase/migrations/20261002000700_*`; `lib/points-ledger.ts`, `lib/money/points-redemption.ts`.
- **Screens and reports:** `app/(admin)/action-queue`, `app/api/admin/action-queue/route.ts`, `lib/money/action-queue.ts`; `lib/money/invoice-ledger-view.ts`, `receipt-payments.ts`, `tenant-statement.ts`, `statement-display.ts`, `report-definitions.ts`; `app/api/payment-liff/invoices/route.ts`, `app/api/receipt/[token]/route.ts`, `app/api/admin/dashboard-stats/route.ts`, `app/api/admin-liff/dashboard/route.ts`, `app/api/cron/daily-digest/route.ts`; `lib/permissions.ts`.
- **Reconciliation and tooling:** `lib/money/reconciliation-*.ts`, `app/api/admin/reconciliation/route.ts`, `scripts/discrepancy-report.ts`.
- **Tests:** `lib/money/*.test.ts` (including `scenarios.test.ts`), `lib/invoice-ledger*.test.ts`, `components/admin/refunds/form-logic.test.ts`, and SQL scripts `supabase/tests/01-10` (`README.md`, `RESULTS.md`).

## 5. How to run checks
```
npm install
npx vitest run
npx tsc --noEmit -p .
```
No database needed. SQL scripts in `supabase/tests/` ran rollback-wrapped on the dummy project `dorm-test` only (results in `supabase/tests/RESULTS.md`); you review SQL by reading. No tests exist for API routes. Not done: UI run in a browser, two-real-session concurrency tests, any check against production.

## 6. Known gaps (do not report as new; do disagree if you think the assessment is wrong)
- Nothing applied to production; production schema and grants unverified; `final-schema.sql` is stale.
- Legacy-shaped rows heuristic (both twins); adjustments have no writer and are not in `computeInvoiceTotal`.
- `approve_paid` skips the slip guard when the chain is already settled; web-admin `update_status` to paid still allowed.
- Findings log: `docs/money-system-findings.md` (read it last to stay independent).

## 7. Review questions
A. Money lost, duplicated or double counted: a receipt without allocations or the reverse; `paid_amount` changed without allocations; void then re-record (reversals netted everywhere? overpayment credit surviving a void?); idempotent replay returning a different result; late fee counted in both `late_fee_amount` and `additional_fees_total`; a carried debt counted at both source and target; non-cash credit counted as cash; a refund payout exceeding refund due.
B. Races in SQL functions: lock order across all money functions (including 0650), check-then-insert idempotency, stale guards, concurrent void and record, `SECURITY`/`search_path`/grants, rounding of numeric versus JSON floats.
C. TS versus SQL twins: `calculateLateFeeAmount` vs `money_late_fee_amount`; `carry-in.ts` vs `money_carried_in_settled`; `getChainOwnOutstanding` vs `final_settle_move_out`; error strings in `payment-errors.ts` vs what SQL raises; status derivation in TS and SQL.
D. Raw writes to `paid_amount`, `total_amount`, `status`, `locked_late_fee_amount`, `payment_history`, or to `payment_batches`/allocations outside the functions: search `.update(` / `.insert(` in `app/` and `lib/`, including LIFF, cron, move-out, transfer, points and `sync_*`.
E. Authorisation: permission per action (`lib/permissions.ts`, owner-only `refund.record`, `settlement.void`, `late_fee.policy`), routes missing `requireAdminPermission`, tenant routes relying on the LINE token.
F. Migration safety: anything that could damage production data if applied in order; a migration that fails on existing data (for example the 0700 reason CHECK); missing rollback notes.
G. Move-out: is advance rent ever refundable? Can `void_move_out_settlement` leave money stranded or half reversed? Are its refusals complete?

## 8. Output format wanted
Findings grouped by severity (Critical, High, Medium, Low, Info). For each: ID and one-line title; location as `path:line` (function name); what can go wrong with a concrete scenario and amounts; confidence (certain / likely / needs data); suggested fix (code or SQL sketch, additive where possible). Then a short list of things you verified correct, and assumptions you could not check because the production schema is not in the repo.
