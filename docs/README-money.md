# Money documentation index

Status 2026-10-03, `main` at `d9923d7` plus the docs sync commit.

**Nothing described in these documents has been applied to production.** The `supabase/migrations/20261002*` files have not been run on the live `ApartmentFlow` database, and the money code on `main` has not been deployed. Everything was exercised only against the dummy project `dorm-test` and by unit tests. Do not run any step below against production without a fresh backup and your explicit decision per file.

## Documents

| File | What it is |
|---|---|
| `CLAUDE.md` | Project rules and history of past money incidents. Read first by anyone touching code. |
| `docs/OPERATOR-GUIDE.md` | Owner-facing: what each money screen does, golden rules, what is still planned. |
| `docs/MONEY-LIFECYCLE.md` | The model: authoritative records, payment/void flow, status table of built vs designed. |
| `docs/money-rewrite-plan.md` | Safety rules and the phase checklist. |
| `docs/money-system-findings.md` | Running log of 88 findings (open issues, risks, decisions needed). |
| `docs/OPUS-HANDOFF.md` | What is reserved for Opus: atomic DB functions and move-out settlement; stopped branches. |
| `docs/AUDIT-BRIEF.md` | Self-contained brief for an external AI auditor: rules, commit range, files per phase, questions, report format. |
| `docs/DISCREPANCY-REPORT-HOWTO.md` | How the owner runs the read-only discrepancy scan and shares redacted output. |
| `docs/TEST-SCHEMA-GAPS.md` | How `dorm-test` was built, inferred objects, and how to diff the production schema against it. |

## What to read first

**(a) The owner**
1. `docs/OPERATOR-GUIDE.md` (all of it).
2. The go-live steps below.
3. `docs/DISCREPANCY-REPORT-HOWTO.md` when ready to scan real data.
4. Skim `docs/OPUS-HANDOFF.md` so you know what is not yet final.

**(b) Opus reviewer**
1. `docs/OPUS-HANDOFF.md`, then `docs/MONEY-LIFECYCLE.md` sections 3, 7, 9 and 12.
2. `supabase/migrations/20261002000000_*` (`void_payment_batch`) and `20261002000500_*` (`record_payment_batch`), with findings 34-36, 44, 51, 64.
3. `lib/invoice-ledger.ts` (callers of those functions), and `lib/money/settlement.ts`, `lib/money/points-redemption.ts`, `lib/money/late-fee.ts` as specs for the unwritten atomic functions.
4. `docs/money-system-findings.md` (all), `CLAUDE.md`.
5. Scope: the atomic DB functions and move-out settlement are yours; the Sonnet-written versions are drafts.

**(c) An external AI auditor**
1. `docs/AUDIT-BRIEF.md` (follow its hard rules: never open `.env*`, no database access).
2. `docs/MONEY-LIFECYCLE.md`, then `CLAUDE.md`.
3. The code by phase as listed in the brief; `git log --oneline 22b5c7a..main`.
4. `docs/money-system-findings.md` last, so your review stays independent; report disagreements.
5. If given data, only a `--redact` discrepancy report (`docs/DISCREPANCY-REPORT-HOWTO.md`).

**(d) Go-live, in order** (all manual, all by the owner)
1. Prerequisites: Opus review of `record_payment_batch` and `void_payment_batch` finished and fixes merged; owner has read the operator guide. Recommended: run the discrepancy report (read-only) and export the production schema to diff against dorm-test (`docs/TEST-SCHEMA-GAPS.md` section 6), because production-only objects (`user_roles`, `invoices.late_fee_billed_at`, `meter_readings.billing_month`) are unverified.
2. **Backup**: take a full Supabase backup or point-in-time snapshot of `ApartmentFlow` and confirm it can be restored. Stop here if not.
3. **Migrations, one at a time, in filename order**, in the Supabase SQL editor, confirming each succeeded before the next. All are additive (new objects only; each file has rollback notes at the top, except the last two which are a single function). Migrations from 2026-06 to 2026-09 (`20260610...` through `20260925...`) are assumed already applied; confirm against production first.
   1. `20261002000000_migration-money-events-and-void-payment.sql`: `money_events` audit table (append-only), void columns on `payment_batches` and `invoice_payment_allocations` (`voided_at/by/reason`, `reverses_allocation_id` with a unique index), function `void_payment_batch()`. Opus-reserved.
   2. `20261002000100_migration-adjustments.sql`: `adjustments` table (append-only: discount, waiver, correction, write_off, reversal). No code writes it yet.
   3. `20261002000200_migration-tenant-credits.sql`: `tenant_credits` (append-only) and view `tenant_credit_balances`. Needed by step 6 and the action queue.
   4. `20261002000300_migration-refund-payouts.sql`: `refund_payouts` and view `refund_due_vs_paid` (requires step 3).
   5. `20261002000400_migration-late-fee-charges.sql`: `late_fee_policies` and `late_fee_charges` (append-only). Not read by live fee logic.
   6. `20261002000500_migration-record-payment-batch.sql`: function `record_payment_batch(jsonb)`, used by every payment recorded through the app (requires step 3). Opus-reserved.
   7. `20261002000600_migration-final-settlement.sql`: `move_out_settlements` and function `final_settle_move_out(jsonb)`. REQUIRED by the deployed `final_move_out` / `abandon_room` actions (and needs steps 1, 3). Advance rent is applied as credit and never becomes refund due.
   8. `20261002000700_migration-points-redemption.sql`: functions `redeem_points_atomic` and `reverse_points_redemption`, plus `point_ledger_entries.reverses_entry_id` and a reason CHECK. REQUIRED by the deployed points code: every points read selects `reverses_entry_id`, so skipping it breaks the points pages. Before applying, run `SELECT DISTINCT reason FROM point_ledger_entries` on production (read-only): the new CHECK fails if it holds a value outside the allowed list. Needs steps 1 and 2.
   9. `20261002000800_migration-late-fee-actions.sql`: functions `post_late_fee_charge`, `waive_late_fee`, `reverse_late_fee_waiver`, `create_late_fee_policy`, `late_fee_engine_check`. REQUIRED by the deployed late-fee routes. Do NOT create any `late_fee_policies` row afterwards until the owner decides: with no policy row the old automatic late-fee behaviour stays exactly as it was. Needs steps 1, 2 and 5.
   - Run the function-permission check after all nine: for each function above `has_function_privilege('anon'|'authenticated', ..., 'EXECUTE')` must be false (only `service_role` may execute them).
   - Before step 1: confirm in production (read-only) that `anon` cannot write money tables (`invoices`, `payment_batches`, `invoice_payment_allocations`, `user_roles`) directly, and that no existing function named `final_settle_move_out` exists. The functions only protect against writes made through them.
   - Set `SET lock_timeout = '5s'` in the SQL editor session and apply off-hours.
   - Do NOT apply `20261002000900_migration-test-schema-inferred.sql` (test project only).
   - Do NOT apply the data-repair files (`20260814000000` step 2, `20260820000001`, `APPLY-IN-SQL-EDITOR.sql`) as part of this; they are separate decisions.
4. **Code deploy last**, only after steps 1-6 succeeded: the deployed code calls `record_payment_batch` and `void_payment_batch`, so deploying first breaks recording and voiding. After deploying, smoke-test on one room: record a small payment, void it, open the reconciliation page and action queue, watch for errors.
5. **Rollback**: each migration file lists its DROP statements; the previous code can be redeployed, but only before new data depends on the new tables. Restore from the backup if anything money-related looks wrong.
6. Afterwards: run the reconciliation page and compare with the pre-migration discrepancy report; treat "legacy, no receipt record" findings as expected.
