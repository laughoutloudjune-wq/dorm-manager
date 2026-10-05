# Test results — audit round 2 (2026-10-05)

Executed vs not executed is stated per item. Nothing here touched production.

## Environments
- **dorm-test** `rghxelkifdrpvabyxopb`: the long-lived dummy project (built incrementally).
- **dorm-replay-disposable** `dareqfpbuymkfzaytdsg`: created empty for this round, used for the clean replay and the concurrency races. Disposable; may be deleted.
- Code: branch `worktree-agent-a020d745d962e74cb`. Migrations 0600 and 0650 (edited this round) were applied to dorm-test from the files, verbatim.

## 1. Unit tests and types (executed)
- `npx tsc --noEmit -p .` clean.
- `npx vitest run`: 37 files, 509 passed, 3 todo.

## 2. SQL scripts on dorm-test, after the final 0600 / 0650 (executed)
Each is rollback-wrapped and ends with a `RAISE EXCEPTION 'RESULT:...'`. No FAIL, PROBE or KNOWN-GAP lines.

| Script | PASS |
|---|---|
| 01_record_payment_batch | 39 |
| 02_void_payment_batch | 31 |
| 03_append_only_and_uniqueness | 51 |
| 04_final_settle_move_out | 21 |
| 05_points_redemption | 34 |
| 06_late_fee_actions | 33 |
| 07_carry_forward_downstream | 14 |
| 08_settlement_downstream | 5 |
| 09_late_fee_freeze | 5 (P1–P9 on one line, "9/9") |
| 10_refund_and_settlement_correction | 26 (R1–R7, R8a, R8b, R9, S1, S1b–d, S2–S12, G1) |

New in script 10 this round: R5 strict future `paid_at` (3 days and 1 minute ahead both refused with PAID_AT_IN_FUTURE; `now()` accepted), S9 exact state restore (different tenant move-out date from the request date, forfeit flag), S10 BEFORE_STATE_MISSING, S11 LATER_ACTIVITY / TENANT_STATE_CHANGED (newer request, later room settlement and tenancy, newer invoice, edited move-out date), S12 ALREADY_VOIDED.

## 3. Clean replay on an empty database (executed, dorm-replay-disposable)
Order: `final-schema.sql` → 20260610 … 20260925 → 20261002 0000, 0100, 0200, 0300, 0400, 0500, 0600, 0650, 0700, 0800. 0900 (test-only) not applied.
- All OK, except 20260610 which errored with "column already exists" because `final-schema.sql` already has those columns (benign).
- Prerequisite not in the documented order: `migration-occupancy-proration.sql` (creates `room_logs`) — without it `final_settle_move_out` fails at run time (test 08: 4 FAIL until applied). Now documented in README-money.
- `invoices.late_fee_billed_at` exists in no repo migration; now added (IF NOT EXISTS) at the top of 0800. The replay was done before that line was added, so that line itself was **not** replayed.
- After the replay: all 12 money functions and 6 tables present, `tenant_before` present, refund/settlement functions not executable by anon/authenticated. Scripts 08 (5 PASS) and 10 (26 PASS) pass on this database.
- Not replayed: the data-repair files (`20260814` step 2, `20260820000001` data part, `APPLY-IN-SQL-EDITOR.sql`) — nothing to repair on an empty DB.

## 4. Two-session concurrency (executed, dorm-replay-disposable)
Method: two separate background sessions (pg_cron one-off jobs) released at the same barrier timestamp, each calling the function and then holding its locks 4 s. Start times matched within 25 ms and the loser finished ~4 s later, i.e. it was blocked on a lock. (Two `execute_sql` calls in one message are serialised by the tool and are not a valid concurrency test.)

| Race | Runs | Result |
|---|---|---|
| C1 payment vs payment (different keys, 800 each on a 1000 invoice) | 2 | One succeeded, the other STALE_INVOICE. Final paid 800, partial, 1 live batch, allocations 800. |
| C2 void of a 500 batch vs new 300 payment | 2 | Both serial orders seen: pay-then-void (paid 300) and void-then-pay-rejected-stale (paid 0). paid_amount = sum of allocations in both. |
| C3 refund payout vs settlement void | 2 | Never both. Void won: payout NOT_SETTLED. Payout won: void SETTLEMENT_HAS_PAYOUT. |
| C4 same idempotency key twice | 2 | One batch; the other call returned `replayed: true` with the same batch id. Paid once. |

Whole-DB integrity afterwards: 0 invoices whose `paid_amount` differs from their allocation sum; 0 batches whose allocations do not match.
Limit: 2 runs per race on one small database; this shows the lock order works, it is not a load test. Leftover test objects (conc_* tables/functions, pg_cron extension, seeded rows) remain in the disposable project only.

## 5. NOT executed
- **Browser workflows** (admin payment, tenant payment/slip, void, move-out settlement, refund payout, settlement correction, and their refusals). The app talks to Supabase with a service-role key; the key of the dummy project cannot be read by me and the app's `.env.local` points at production, which must not be used. No screen was exercised in a browser this round or before. The unit tests cover the form logic and API error mapping, not the rendered pages.
- Load / many-session concurrency.
- Production: schema unknown until `docs/PRODUCTION-PRECHECKS.sql` is run by the owner.
