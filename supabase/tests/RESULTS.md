# Test results

Run date: 2026-10-03 (second run, after the Opus hardening). Project: dorm-test (rghxelkifdrpvabyxopb) only.
All scripts rolled back; a post-run check found no leaked fixture rows (0 test tenants, 0 test rooms, 0 test batches,
0 test events, 0 test credits).

Functions under test: `record_payment_batch(jsonb)` and `void_payment_batch(uuid,text,text)` as now written in migrations
20261002000500 and 20261002000000, applied to dorm-test together with the CHECK-constraint changes of 0100-0400.
The applied function bodies were verified byte-identical to the files (md5 of `pg_proc.prosrc` equals md5 of the file body).

Every former KNOWN-GAP and PROBE case is now an ordinary assertion. Totals: 01 = 37 PASS, 02 = 25 PASS, 03 = 52 PASS, 0 FAIL.

## 01_record_payment_batch.sql
```
PASS  R1 normal multi-invoice payment, invoices given out of id order (batch=1 allocs=2 A=1000.00/paid B=1500.00/partial events=1 credits=0 A.hist=[{"x": 1}])
PASS  R2 idempotent replay same key, checked after locks, even with a now-stale payload (replayed=true same_id=true voided=false batches=1 allocs=2 A.paid=1000.00)
PASS  R3 unique-violation path re-raises when no idempotent winner exists (SQLSTATE 23505). Same-key two-session race needs two connections (see README).
PASS  R4 STALE_INVOICE on changed paid_amount (STALE_INVOICE <id> (paid_amount changed from 0 to 300.00))
PASS  R4b invoice untouched after STALE_INVOICE
PASS  R5 allocation sum mismatch rejected (allocations (600) do not equal amount_allocated (700))
PASS  R6 overpayment creates exactly one overpayment credit (300)
PASS  R6b replay of overpaid receipt adds no second credit
PASS  R7 (finding 35) batch for tenant A paying tenant B's invoice rejected (TENANT_MISMATCH trigger invoice <id> belongs to tenant <B>, not batch tenant <A>)
PASS  R7b chain containing another tenant's invoice rejected (TENANT_MISMATCH invoice <id> belongs to tenant <B>, not <A>)
PASS  R7c NULL batch tenant: invoices must share the trigger invoice's tenant (TENANT_MISMATCH ...)
PASS  R7d NULL batch tenant with same-tenant invoices and no excess accepted
PASS  R8 (finding 36) concurrent payment_history change detected (STALE_INVOICE <id> (payment_history changed from 0 to 1 entries))
PASS  R8b concurrent history entry preserved
PASS  R8c existing history entries never overwritten (only the new tail is appended)
PASS  R8d missing expected_history_length rejected (INVALID_PAYLOAD invoice <id> needs a non-negative integer expected_history_length)
PASS  R8e payment onto a fully paid invoice rejected (OVERPAID_INVOICE invoice <id> would reach paid_amount 801 above its total 800.00; ...)
PASS  R9 received|allocated=0|0 rejected (amount_received must be greater than 0)
PASS  R9 received|allocated=100|200 rejected (amount_allocated must be between 0 and amount_received)
PASS  R9 received|allocated=-5|0 rejected (amount_received must be greater than 0)
PASS  R9 unknown invoice id (INVOICE_NOT_FOUND <uuid>)
PASS  R10 (finding 106) excess with NULL tenant_id rejected (TENANT_REQUIRED amount_received exceeds amount_allocated by 800 but batch.tenant_id is missing, ...)
PASS  R11 negative allocation [600,-500] rejected (INVALID_PAYLOAD allocation for invoice <id> must be greater than 0 (got -500))
PASS  R12 paid_amount not equal to old + allocation (99999) rejected (INVALID_PAYLOAD invoice <id> paid_amount 99999 must equal current 200.00 plus its allocations 50)
PASS  R13 paid_amount above total_amount rejected (OVERPAID_INVOICE invoice <id> would reach paid_amount 600 above its total 500.00; ...)
PASS  R14 status cancelled (not a payment status) rejected (INVALID_PAYLOAD invoice <id> status cancelled is not a valid payment status)
PASS  R14b unknown status rejected (INVALID_PAYLOAD invoice <id> status bogus is not a valid payment status)
PASS  R14c status paid while balance still owed rejected (INVALID_PAYLOAD invoice <id> cannot be marked paid with paid_amount 250 below total 500.00)
PASS  R15 3-decimal amounts rejected (INVALID_PAYLOAD amounts must have at most 2 decimals (received 50.005, allocated 50.005))
PASS  R16 allocation to an invoice missing from invoices[] rejected (INVALID_PAYLOAD allocation for invoice <id> has no matching entry in invoices[])
PASS  R17 invoices[] entry without allocation (status-only rewrite) rejected (INVALID_PAYLOAD invoice <id> is in invoices[] but receives no allocation)
PASS  R18 missing expected_paid_amount rejected (INVALID_PAYLOAD invoice <id> needs a numeric expected_paid_amount)
PASS  R19 duplicate invoice in invoices[] rejected (INVALID_PAYLOAD invoices[] lists the same invoice more than once)
PASS  R20 payment to a cancelled invoice rejected (INVOICE_NOT_PAYABLE invoice <id> is cancelled)
PASS  R21 every recorded batch has one payment.record event with before/after invoices and allocations (3)
PASS  R22 only service_role can execute record_payment_batch
```
Summary: 37 PASS, 0 FAIL. Every rejection case also asserts that no batch row was written.

## 02_void_payment_batch.sql
```
PASS  V1 normal void, reason stored trimmed (res.voided=true reversed=2 A=0.00/pending B=0.00/pending originals_kept=2 reversals=2 net_alloc=0.00 batch=true/wrong amount entered/tester)
PASS  V6 event rows written (1 payment.record + 2 payment.void with reason+actor)
PASS  V1b void entry appended to payment_history on both invoices
PASS  V2 double void rejected (Payment batch already voided; allocation rows still 4)
PASS  V3 blank reason [] rejected
PASS  V3 blank reason [   ] rejected
PASS  V3 blank reason [\t\n] rejected
PASS  V3 blank reason [\r\n \t] rejected
PASS  V3 NULL reason rejected (A reason is required to void a payment)
PASS  V3b batch untouched after rejected voids
PASS  V3c payment_batches_void_reason_check blocks a blank void_reason on direct UPDATE
PASS  V4 unknown batch rejected (Payment batch not found)
PASS  V5a paid -> partial after voiding the 400 batch (600.00/partial)
PASS  V5b partial -> pending after voiding the rest (0.00/pending)
PASS  V5c paid -> overdue when the due date has passed (0.00/overdue)
PASS  V7 (finding 44) void reverses the 300 overpayment credit with one linked reversal row + credit.reversal event (net 0)
PASS  V7b tenant_credit_balances.unapplied_credit back to 0
PASS  V7c second reversal of the same credit blocked (uq_tenant_credits_single_reversal)
PASS  V7d void refused when the overpayment credit was already spent (VOID_CREDIT_ALREADY_USED this receipt left 300.00 as tenant credit but only 0.00 unapplied...; nothing written)
PASS  V8 (finding 108) void refused, error names the invoice, nothing written (VOID_WOULD_MAKE_NEGATIVE invoice <id> ...)
PASS  V9a verifying with a slip awaiting review stays verifying (0.00/verifying)
PASS  V9b verifying without a pending slip downgrades (0.00/pending)
PASS  V9c verifying on the voided receipt's own slip downgrades (0.00/pending)
PASS  V10 cancelled invoice stays cancelled after void, flagged status_kept in the event (0.00/cancelled)
PASS  V11 only service_role can execute void_payment_batch
```
Summary: 25 PASS, 0 FAIL.

## 03_append_only_and_uniqueness.sql
All 52 cases PASS: M1-M3, A1-A10, T1-T10, R1-R12, L1-L10, W1-W6.
- W1-W5 (finding 105): tab/newline/CR-only text is now rejected by `adjustments_reason_not_blank`, `refund_payouts_void_consistent`,
  `tenant_credits_reason_check`, `late_fee_charges_formula_check`, `late_fee_charges_posted_by_check`. W6: real text with
  surrounding whitespace is still accepted.
- T10: `reverses_credit_id` is only allowed on `kind = 'reversal'` rows (`tenant_credits_reverses_kind_check`).

## Known gaps (stay documented for Opus; tests intentionally left failing)
- R7 finding 35: `record_payment_batch` does not check that each invoice belongs to `batch.tenant_id`.
- R8 finding 36: STALE_INVOICE only guards `paid_amount`; a concurrent `payment_history` change is silently overwritten.
- V7 finding 44: `void_payment_batch` leaves the `tenant_credits` 'overpayment' row for the voided batch (orphan credit).

## New defects found (not in findings 34-36, 44)
1. Whitespace-only reason check uses `btrim()` (spaces only): tab/newline-only reasons pass in `void_payment_batch` and in the CHECKs
   of adjustments.reason, refund_payouts.void_reason, late_fee_charges.formula/posted_by. Fix: `btrim(x, E' \t\r\n')` or `x ~ '^\s*$'`.
2. `record_payment_batch` with NULL `tenant_id` and `amount_received > amount_allocated` drops the excess (no credit row) while the event still logs `credit`.
3. `record_payment_batch` does not validate allocations: negative allocation amounts are accepted if they net to `amount_allocated`, and allocations are not required to match `invoices[]` or `paid_amount` deltas; caller `paid_amount` (e.g. 99999 on a 100 invoice) is stored unchecked.
4. `void_payment_batch` can drive `invoices.paid_amount` negative when it was changed after the receipt (no floor / drift check), and leaves status `verifying` untouched.

## 05_points_redemption.sql (run 2026-10-03 on dorm-test, migration 20261002000700 applied)
Tests `redeem_points_atomic` / `reverse_points_redemption`. Fixtures: 3 tenants (A 5000 pts, B 100 pts, C 20000 pts), 8 invoices; rate 10 pts/baht, cap 300 baht.
```
PASS  P1  redeem 1500 pts -> 150 baht: ledger -1500 + adjustment points_redemption 150 (same key) + invoice 3500->3350, discount 150, 1 breakdown line with key, 1 money_event; paid_amount 0, no payment_batches; balance 5000->3500
PASS  P2  same key replays (even with the monthly limit used); no new rows
PASS  P2b same key on a different invoice -> IDEMPOTENCY_KEY_REUSED
PASS  P2c key already used by an unrelated adjustment -> IDEMPOTENCY_KEY_REUSED (key unique across both writes)
PASS  P3  blank/whitespace key rejected
PASS  P4  second redemption in the same Bangkok month at limit 1 -> MONTHLY_LIMIT;  P4b allowed at limit 2
PASS  P5  1500 pts with balance 100 -> INSUFFICIENT_POINTS, nothing written
PASS  P6a 300 baht on rent 100 + late fee 500 + carry 1000 + common 50 -> DISCOUNT_CAP (redeemable 100)
PASS  P6b exactly the rent (100) accepted;  P6c rent already fully discounted -> DISCOUNT_CAP
PASS  P6d partly paid invoice whose remainder is only a late fee -> DISCOUNT_CAP (redeemable 0)
PASS  P6e utility coupon 150 on water+electricity 100 -> DISCOUNT_CAP;  P6f 301 baht over cap 300 -> DISCOUNT_CAP
PASS  P7a points/baht ratio mismatch -> RATIO_MISMATCH
PASS  P7b new total != expected - discount -> INCONSISTENT_COLUMNS;  P7c redemption also changing carry_forward_amount -> INCONSISTENT_COLUMNS
PASS  P7d invoice of another tenant rejected;  P7e paid invoice rejected
PASS  C1a two requests computed from the same read: first applies, second STALE_INVOICE (total_amount)
PASS  C1b paid_amount changed between read and redeem -> STALE_INVOICE;  C1c reversal from a stale row (water_bill) -> STALE_INVOICE
PASS  R1  reversal: +1500 'redemption_reversal' (reverses_entry_id -> original, key '<k>:reversal') + adjustment 'reversal' -150 (reverses_adjustment_id -> original, same key); originals kept; invoice 3350->3500, discount 0, line removed; 1 money_event; balance 3400->4900
PASS  R2  second reversal -> ALREADY_REVERSED
PASS  R3  reversed redemption still counts toward the monthly limit (limit 2, 2 redemptions this month incl. the reversed one -> MONTHLY_LIMIT)
PASS  R4a tab/newline-only reason rejected;  R4b reversing an earn row rejected;  R4c reversing a reversal rejected
PASS  R5  reversal on a paid invoice -> INVOICE_CLOSED
PASS  R6  legacy redemption (no key, no adjustment) reversed with a 'correction' -150 under 'redemption:<id>:reversal'; only its own breakdown line removed
PASS  A1a redemption adjustment cannot be deleted (append-only);  A1b reversed redemption row cannot be deleted (FK RESTRICT);  A1c reverses_entry_id only allowed on redemption_reversal rows
PASS  D1  every redemption/reversal row has an opposite-signed adjustment of equal baht under the same key
```
Summary: 34 PASS, 0 FAIL.
Limits: true two-session races cannot run in one transaction; C1 simulates them with stale `expected` values. The row-lock path (invoice FOR UPDATE, then the tenant's point rows ORDER BY id FOR UPDATE) and the unique-violation replay branch are not exercised by a real concurrent session.
Not covered by design: a redemption that has NOT been reversed can still be hard-deleted from point_ledger_entries (no append-only trigger on that table, because syncPointsForTenant still updates/deletes earn rows).
## Not covered here
- True two-connection races (same idempotency key in flight twice; two multi-invoice payments locking in opposite payload
  order; record vs void on the same invoice). The functions lock in ascending invoice id and check idempotency after the
  locks; that ordering is by construction, not exercised by a concurrent test. Needs two sessions (e.g. psql x2 or dblink).
