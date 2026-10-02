# supabase/tests - rollback-wrapped SQL tests for the money functions

Run ONLY on the dummy project `dorm-test` (id `rghxelkifdrpvabyxopb`). Never on production.
These scripts create fake tenants/rooms/invoices, so they need the test schema (migrations
20261002000000-500 plus 20261002000900 applied).

## How they work
Each script is one `DO` block (plus, in 02 and 03, a `pg_temp` helper function that disappears with the
session). The block builds fixtures, calls the function, appends one line per case to a text variable and
ends with `RAISE EXCEPTION 'RESULT:...'`. The exception rolls back everything, so nothing persists, and the
SQL tool / psql shows the result lines as the error message. Run a script by pasting the whole file
into `execute_sql` (or the SQL editor) of dorm-test. The "error" containing `RESULT:` is the success path;
any other error (e.g. a fixture constraint) means the script itself needs fixing.

## Line prefixes
- `PASS` - behaved as specified.
- `FAIL` - behaved wrongly (a defect).
- `KNOWN-GAP` - fails today on purpose; documented in docs/money-system-findings.md and docs/OPUS-HANDOFF.md.
  Do not "fix" the test; fix the function, after which the line flips to `UNEXPECTED-PASS` (then turn it into a normal PASS check).
- `UNEXPECTED-PASS` - a known gap now passes (gap fixed).
- `PROBE` - observation without a verdict, used to surface possible new defects.

## Files
- `01_record_payment_batch.sql` - R1 normal multi-invoice, R2 idempotent replay, R3 unique-violation path, R4 STALE_INVOICE,
  R5 allocation-sum mismatch, R6 overpayment credit (exactly one row), R7 tenant ownership (finding 35),
  R8 payment_history stale guard and append-only history (finding 36), R9 input validation, R10 excess without tenant (106),
  R11-R20 payload validation (107), R21 money_events completeness, R22 EXECUTE grants.
- `02_void_payment_batch.sql` - V1 normal void, V1b history entry, V2 double void, V3 blank/whitespace reason (105), V4 unknown batch,
  V5 status after void (partial/pending/overdue), V6 money_events written, V7 overpayment credit reversal (44),
  V8 no negative paid_amount (108), V9 verifying (108), V10 cancelled not reopened, V11 EXECUTE grants.
- `03_append_only_and_uniqueness.sql` - append-only triggers and uniqueness for money_events (M), adjustments (A),
  tenant_credits (T), refund_payouts void-once (R), late_fee_charges/policies incl. duplicate posting (L),
  whitespace-only text rejected by every "not blank" CHECK (W).
- `RESULTS.md` - actual results of the last run on dorm-test.

## Limits
- The concurrent race in R3 cannot be reproduced in one transaction. The test forces the unique-violation branch via a duplicate
  batch primary key (re-raise path). The same-key "return the winner" branch needs two simultaneous connections.
- Tests do not edit functions. There are currently no KNOWN-GAP cases; a new one should be added as KNOWN-GAP and flipped to
  a plain assertion once fixed.
