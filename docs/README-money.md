# Money documentation index

Status October 2026, feature branch (baseline `22b5c7a`).

**Nothing described here has been applied to production.** The `supabase/migrations/20261002*` files have not been run on the live `ApartmentFlow` database and the code has not been deployed. Everything was exercised only on the dummy project `dorm-test` (rollback-wrapped SQL scripts) and by unit tests. The browser UI has not been run, and concurrency with two real sessions has not been tested. Production state is unverified.

## Documents

| File | What it is |
|---|---|
| `CLAUDE.md` | Project rules and incident history. The last section, "Money rules as implemented (October 2026)", corrects older statements. |
| `docs/OPERATOR-GUIDE.md` | Owner-facing: what each money screen does, golden rules. |
| `docs/MONEY-LIFECYCLE.md` | The model: authoritative records, rules, implemented vs not. |
| `docs/AUDIT-BRIEF.md` | Brief for an external AI auditor: commit range, files, questions, report format. |
| `docs/OPUS-HANDOFF.md` | "Notes for the external auditor": design decisions and known limitations to check first. |
| `docs/money-rewrite-plan.md`, `docs/money-system-findings.md` | Plan and running findings log (written by the owner's agent). |
| `supabase/tests/README.md`, `supabase/tests/RESULTS.md` | SQL test scripts 01-10 and their results. |
| `docs/PRODUCTION-PRECHECKS.sql` | Read-only precheck queries to run on production before migrating. |
| `docs/DISCREPANCY-REPORT-HOWTO.md`, `docs/TEST-SCHEMA-GAPS.md` | Read-only discrepancy scan; how dorm-test differs from production. |

## What to read first
- Owner: `docs/OPERATOR-GUIDE.md`, then the go-live list below.
- External auditor: `docs/AUDIT-BRIEF.md` (never open `.env*`, no database access), `docs/OPUS-HANDOFF.md`, `docs/MONEY-LIFECYCLE.md`, then code by phase; read `docs/money-system-findings.md` last.

## Migrations, in filename order
| File | Contents |
|---|---|
| `20261002000000` | `money_events` (append-only), void columns, `void_payment_batch`, carry-forward helpers `money_carried_in_settled`, `money_downstream_ids`, `money_rederive_downstream`, `money_late_fee_amount`, `money_derive_invoice_status_cf` |
| `20261002000100` | `adjustments` (no writer yet) |
| `20261002000200` | `tenant_credits` and view `tenant_credit_balances` |
| `20261002000300` | `refund_payouts` and view `refund_due_vs_paid` (needs 0200) |
| `20261002000400` | `late_fee_policies`, `late_fee_charges` |
| `20261002000500` | `record_payment_batch(jsonb)` |
| `20261002000600` | `move_out_settlements`, `final_settle_move_out(jsonb)` |
| `20261002000650` | `record_refund_payout`, `void_refund_payout`, `void_move_out_settlement` (new) |
| `20261002000700` | points: `redeem_points_atomic`, `reverse_points_redemption`, `reverses_entry_id` + reason CHECK |
| `20261002000800` | late-fee actions: `post_late_fee_charge`, `waive_late_fee`, `reverse_late_fee_waiver`, `create_late_fee_policy`, `late_fee_engine_check` |
| `20261002000900` | **Test project only. Never apply to production.** |

## Go-live order (all manual, by the owner; none done yet)
1. **Backup** `ApartmentFlow`; confirm it can be restored. Stop if not.
2. **Read-only production prechecks**: run `docs/PRODUCTION-PRECHECKS.sql` (written separately; this file only references it). Also confirm `anon` cannot write money tables, and run `SELECT DISTINCT reason FROM point_ledger_entries` (the 0700 CHECK fails on unexpected values).
2b. **Prerequisite found by the fresh-database replay (2026-10-05):** `final_settle_move_out` (0600) inserts into `room_logs`, which is created only by `supabase/migration-occupancy-proration.sql`. Production almost certainly has it (the app already writes `room_logs`); the precheck file confirms. A database built from the repo files needs that file applied before 0600. `invoices.late_fee_billed_at` is now added (IF NOT EXISTS) at the top of 0800.
3. **Migrations one at a time in filename order** (0000, 0100, 0200, 0300, 0400, 0500, 0600, 0650, 0700, 0800) in the SQL editor with `SET lock_timeout = '5s'`, off-hours, confirming each succeeds. Files 0000-0800 and 0650 have rollback notes at the top. Do not apply 0900. Do not apply the data-repair files (`20260814000000` step 2, `20260820000001`, `APPLY-IN-SQL-EDITOR.sql`).
4. **Verify function permissions**: for every money function above, `has_function_privilege('anon'|'authenticated', <fn>, 'EXECUTE')` must be false; only `service_role` may execute.
5. **Deploy code last**, only after all migrations succeeded (deployed code calls these functions). Smoke-test on one room: record a small payment, void it, open reconciliation and action queue.
6. Do not create any `late_fee_policies` row until the owner decides; with none, the old automatic late-fee behaviour is unchanged.
7. Rollback: each migration lists its DROP statements; redeploy previous code only before new data depends on new tables; otherwise restore the backup.
8. Afterwards: compare the reconciliation page with the pre-migration discrepancy report ("legacy, no receipt record" findings are expected).

## Checks you can run
`npx vitest run` (unit tests), `npx tsc --noEmit -p .` (types). SQL scripts `supabase/tests/01-10` run only on dorm-test, rollback-wrapped; results in `supabase/tests/RESULTS.md`.
