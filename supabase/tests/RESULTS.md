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


---

# Addendum: browser run and final re-runs (2026-10-05, later)

## A. Fresh replay on a second empty database, `dorm-replay-2` (`xqgeiwzetzafbzsqmock`) (executed)
Applied in order, one file per call, verbatim: `final-schema.sql`; 20260610 … 20260925 (dated); `migration-occupancy-proration.sql`; `20261002` 0000, 0100, 0200, 0300, 0400, 0500, 0600, 0650, 0700, 0800. 0900 not applied. 0800 (with its new `late_fee_billed_at` ALTER) applied OK and the column exists.
- Only error: 20260610 "column already exists" (benign, `final-schema.sql` already has it).
- All 12 money functions present; none executable by anon/authenticated.
- Scripts 01–10: 259 PASS, 0 FAIL at that point.
- To run the app the database also needed things that are **not** in the money migrations and are production's own: `user_roles` and the storage buckets (from the test-only 0900, applied by hand) and ten older undated migrations (`migration-move-out-requests`, `-move-out-notice-date`, `-tenants-updated-at`, `-tenant-move-out-deposit`, `-policy-acceptance`, `-invoice-ledger`, `-line-meter-staff-status`, `-notify-flags`, `-room-takeover-requests`, `-tenant-room-transfers`); without them the dashboard failed with `move_out_requests.notice_date does not exist`. A database built only from the money migrations is not enough to run the app.
- Caveat: after the browser run found finding 203, the new `refund_due_vs_paid` definition was applied to this database by pasting that one statement, not by re-running the whole 0650 file.

## B. Browser workflows (executed, Chrome-based in-app browser, app on localhost:3100 connected to `dorm-replay-2`)
The dev server was started from the worktree with the dummy database's variables only (the session cookie was named for the dummy project, confirming the target). A throwaway owner login was created on the dummy project only. Browser confirm/prompt dialogs were answered by a script stand-in in the page; no app code was altered for that.

| Workflow | Result |
|---|---|
| Admin records a payment (invoice modal, partial 1,000 of 3,000) | OK. Batch, allocation with source `admin_webapp`, `payment.record` event, status partial. Header, ledger and per-row balances agreed. |
| Large-payment warning (3,500 on a 3,000 invoice) | Warning shown; declining it recorded nothing. (It showed a stale remaining figure, see finding 201, fixed.) |
| Admin voids a payment (preview "1,000 → 0", reason required) | OK. Reversal row, `payment.void` event, invoice back to pending. Found and fixed: modal header stayed stale (201). |
| Admin pays an invoice in full (Tenant B, 3,000) | OK, status paid. |
| Move-out wizard, 4 steps, tenant with 2 unpaid invoices and a 3,000 deposit | OK. Deposit credit paid the oldest invoice, newer invoice stayed owed, tenant inactive, room available, final invoice created, `tenant_before` saved. |
| Move-out wizard, tenant with a paid invoice and a 3,000 deposit | OK. Refund due 3,000, nothing owed. |
| Settlements list | Initially failed (202, fixed); then listed both settlements with tenant-level figures on the live row and dashes on the voided row. |
| Refund payout form | Over-amount and future time blocked in the form; server refused future time (400 PAID_AT_IN_FUTURE), over-amount (409 REFUND_EXCEEDS_DUE) and an unsettled tenant (409 NOT_SETTLED). A valid payout (1,000, reference REF-001) saved: due 3,000, paid 1,000, outstanding 2,000. |
| Settlement void while a payout is live | Button disabled with a message; the server also refused (409 SETTLEMENT_HAS_PAYOUT). |
| Void the payout (reason required) | OK; outstanding back to 3,000. |
| Void the settlement (reason required, both tenants) | OK. Tenants active, in their rooms, original scheduled move-out date (31 Oct) restored exactly, invoices reopened, deposit credit reversed, final invoice cancelled, no refund-due row left (finding 203, fixed). |
| Permissions over HTTP (throwaway admin and viewer users, no token) | admin: list 200, record/void payout and void settlement 403; viewer: all 403; no token 401. |

Not exercised in the browser: tenant-side payment / slip upload in LINE (finding 204); settlement void refusals LATER_ACTIVITY and TENANT_STATE_CHANGED (SQL script 10 S11 only); mobile layout.

## C. Final re-runs after the last SQL change (executed)
- `dorm-test`: scripts 01–09 all PASS (agent-counted: 39, 31, 51, 21, 37, 33, 14, 5, 5; earlier tallies for 05 were 34, the difference is counting of result lines, not a change in the script). Script 10: 27 PASS, 0 FAIL (R1–R9 incl. R8a/b, S1, S1b–d, S2–S13, G1), after S1 was updated to expect no refund-due row for a voided settlement.
- `dorm-replay-2`: script 10: 27 PASS, 0 FAIL, line for line identical to dorm-test.
- `npx tsc --noEmit -p .` clean; `npx vitest run`: 37 files, 509 passed, 3 todo.

## D. Still not executed
- Tenant (LINE) payment and slip workflows in a browser; load or many-session concurrency; production prechecks (owner); a run of the full browser flow on a database built only from repo files plus the ten undated legacy migrations (the replay-2 database was built that way, plus 0900's two items, but the browser run used it after later manual view re-application).


---

# Addendum 2: clean replay of the FINAL files on a fresh database (2026-10-05)

Project `dorm-replay-3` (`ejofevufznrohstpjgva`), created empty for this run. Built in one pass from the committed files at HEAD (final 0600, 0650 with the refund-due view, 0800 with `late_fee_billed_at`), no hand-applied statements except the two items below. Nothing was re-applied afterwards.

Order and parallelism: phase 1 (one agent, sequential): `final-schema.sql`, dated 20260610 … 20260925, `migration-occupancy-proration.sql`. Phase 2 (two agents in parallel on separate objects): (A) money migrations 20261002 0000, 0100, 0200, 0300, 0400, 0500, 0600, 0650, 0700, 0800 in order; (B) the ten undated app migrations plus `user_roles` and the three storage buckets (the two items taken from the test-only 0900; 0900 itself was not applied). Phase 3 (three agents in parallel, rollback-wrapped scripts): 01–03, 04–06, 07–10.

- Phase 1: all OK; the only error was 20260610 "column already exists" (benign: the base schema already has it).
- Phase 2A: all ten money migrations OK, no retries. The agent pasted each file's executable SQL in full but **dropped the header comment blocks and trailing rollback comments**, so this is not byte-for-byte. Check performed by me afterwards: the normalized body hash (comments and whitespace removed, md5) of all 12 money functions in the database equals the hash of the function body in the committed file (12 of 12). Tables, triggers, indexes and the view were **not** hash-compared; the agent confirmed `tenant_before`, `late_fee_billed_at`, that the view mentions `move_out_settlements`, and that anon/authenticated cannot EXECUTE the six payment/settlement/refund functions.
- Phase 2B: all OK, no errors.
- Phase 3 results (agent-tallied result lines; every call ended with the expected RESULT exception; no deadlocks or reruns):

| Script | PASS | FAIL | PROBE / KNOWN-GAP |
|---|---|---|---|
| 01_record_payment_batch | 40 | 0 | 0 |
| 02_void_payment_batch | 30 | 0 | 0 |
| 03_append_only_and_uniqueness | 52 | 0 | 0 |
| 04_final_settle_move_out | 21 | 0 | 0 |
| 05_points_redemption | 34 | 0 | 0 |
| 06_late_fee_actions | 33 | 0 | 0 |
| 07_carry_forward_downstream | 14 | 0 | 0 |
| 08_settlement_downstream | 5 | 0 | 0 |
| 09_late_fee_freeze | 5 (P1–P9 on one line) | 0 | 0 |
| 10_refund_and_settlement_correction | 27 (R1–R9 incl. R8a/b, S1, S1b–d, S2–S13, G1) | 0 | 0 |

Per-script counts differ by one or two from earlier runs for 01, 02, 03 (40/30/52 here vs 39/31/51): these are agent tallies of result lines and the sum is the same (121 vs 121); no line was reported as non-PASS.
Not done on this database: the browser run (it was done on `dorm-replay-2`, built the same way except the view statement was pasted by hand) and the concurrency races (done on `dorm-replay-disposable`).


---

# Addendum 3: late fees at move-out, and the clean replay of the FINAL files (2026-10-06 / 10-10)

New feature (migration edits in 0600 and 0650, TS in the move-out route/wizard): unbilled late fees on the tenant's older invoices are billed as lines on the final invoice; each can be voided by an admin with a reason. Global-setting (legacy) mode only; with a `late_fee_policies` row the move-out offers none.

## A. Fresh database `dorm-replay-4` (`vmkeqguyhljansjmgdgj`), built from the committed files at HEAD (executed)
Phases: (1) `final-schema.sql`, dated 20260610 … 20260925, `migration-occupancy-proration.sql`; (2) in parallel: the ten money migrations 0000 … 0800 in order, and the ten undated app migrations + `user_roles` + three storage buckets (from the test-only 0900; 0900 not applied); (3) scripts in three parallel groups.
- **The replay found a real ordering bug**: 0600 failed with `column i.late_fee_billed_at does not exist` (the new `move_out_late_fee_candidates` reads it, and only 0800 / the test-only 0900 added it). It had been invisible on `dorm-test`, which had the column from 0900. Fixed in the file (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` at the top of 0600) and re-applied; the failed 0600 had rolled back whole.
- Procedure note: 0000–0500 were applied before the failure and kept; 0600 (fixed), 0650, 0700, 0800 were applied afterwards. 0800 was cut off once by the tool and re-sent complete. Not one uninterrupted pass, but every file applied is the committed final file.
- Normalized body hash (comments and whitespace removed) of all 13 money functions in the database equals the committed file's function body (13 of 13: the 12 earlier ones plus `move_out_late_fee_candidates`). Tables, triggers, indexes and views were not hash-compared.

| Script | PASS | FAIL |
|---|---|---|
| 01_record_payment_batch | 39 | 0 |
| 02_void_payment_batch | 31 | 0 |
| 03_append_only_and_uniqueness | 51 | 0 |
| 04_final_settle_move_out | 21 | 0 |
| 05_points_redemption | 33 | 0 |
| 06_late_fee_actions | 33 | 0 |
| 07_carry_forward_downstream | 14 | 0 |
| 08_settlement_downstream | 5 | 0 |
| 09_late_fee_freeze | 5 (P1–P9 on one line), after the fixture fix below | 0 |
| 10_refund_and_settlement_correction | 27 | 0 |
| 11_late_fee_at_move_out | 10 (L1–L9, L6b) | 0 |

Counts are agent tallies of result lines (small differences from earlier tallies, e.g. script 05, are counting, not changes).
- Script 09 test U4 first failed on this database with `LATE_FEE_MISMATCH`: it settled a tenant whose older invoice carries a 230 late fee without saying what to do with it, which the database now (correctly) refuses. The fixture now bills the 230 + 460 fees on the final invoice; the freeze behaviour it checks is unchanged and passes. Script 04's S5c was likewise date-dependent (due date 2026-10-05 became overdue on 6 Oct) and its fixture date was moved to 2099.
- Script 11 and the changed 09 also pass on `dorm-test`. On `dorm-test` scripts 01–03, 05–07 were not re-run after the final 0600/0650; the fresh database above is the evidence for them.

## B. Browser (executed on `dorm-replay-2`, with the final 0600/0650 applied; that database was not rebuilt)
Move-out wizard for a tenant with 310 + 60 of unbilled late fees: both fees shown with period, days × rate; voiding the 60 fee needs a reason (confirm disabled until given), the final bill drops 370 → 310 and the totals update; confirmed: the 310 fee is a `late_fee_line` on the final invoice, the 60 fee is marked waived with the reason in the audit log, source invoices marked billed; voiding the settlement afterwards restored both fees (billed flag cleared, offered again, final invoice cancelled). A tenant without late fees settled normally (no late-fee section).
Not exercised in the browser: billing all fees without voiding any (SQL L1), a fee-list change between preview and confirm (SQL L4 only), tenant-side LINE pages.

## C. Still not done / limits
- Production prechecks, backup, applying to production: owner steps.
- Browser run not repeated on the fresh `dorm-replay-4`; concurrency races were run before the late-fee change.
- Late fee amounts are computed as of the settlement date (the date part of the payment time), the same date the existing freeze uses; if the preview was loaded the day before, the database refuses a mismatch and the admin must reload.
