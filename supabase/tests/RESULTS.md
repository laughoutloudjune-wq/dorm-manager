# Test results

Run date: 2026-10-03. Project: dorm-test (rghxelkifdrpvabyxopb) only. All scripts rolled back; a post-run check found no leaked
fixture rows (0 test tenants, 0 test batches, 0 test events).

Functions under test as found on dorm-test: `record_payment_batch(jsonb)` and `void_payment_batch(uuid,text,text)` exactly as in
migrations 20261002000000 and 20261002000500 (not modified by this work).

## 01_record_payment_batch.sql
```
PASS  R1 normal multi-invoice payment (batch=1 allocs=2 A=1000.00/paid B=1500.00/partial events=1 credits=0)
PASS  R2 idempotent replay same key (replayed=true same_id=true batches=1 allocs=2 A.paid=1000.00)
PASS  R3 unique-violation path re-raises when no idempotent winner exists (SQLSTATE 23505). NOTE: same-key two-session race (replay-from-handler branch) is NOT exercisable single-session; needs two connections.
PASS  R4 STALE_INVOICE (STALE_INVOICE <id> (paid_amount changed from 0 to 300.00); nothing written)
PASS  R5 allocation sum mismatch rejected (allocations (600) do not equal amount_allocated (700))
PASS  R6 overpayment creates exactly one overpayment credit (300)
PASS  R6b replay of overpaid receipt adds no second credit
KNOWN-GAP  R7 (finding 35) batch for tenant A paid tenant B's invoice and was ACCEPTED; expected rejection.
KNOWN-GAP  R8 (finding 36) payment accepted and concurrent payment_history entry was OVERWRITTEN; history now=[{"type": "payment", "amount": 800}]
PASS  R9 received|allocated=0|0 rejected (amount_received must be greater than 0)
PASS  R9 received|allocated=100|200 rejected (amount_allocated must be between 0 and amount_received)
PASS  R9 received|allocated=-5|0 rejected (amount_received must be greater than 0)
PASS  R9 INVOICE_NOT_FOUND (INVOICE_NOT_FOUND <uuid>)
PROBE  P1 overpayment (received 900, allocated 800) with NULL tenant_id -> credit rows=0 (100 excess silently dropped, event still logs credit=100)
PROBE  P2 allocations [600,-500] summing to amount_allocated=100 were ACCEPTED (negative allocation rows allowed; collides with reversal-row semantics)
PROBE  P3 invoice total 100, allocation 50, caller paid_amount=99999 -> stored 99999.00/paid (paid_amount is not validated against allocations or total)
```
Summary: 12 PASS, 2 KNOWN-GAP (R7 finding 35, R8 finding 36), 3 PROBE (new defects, see below), 0 FAIL.

## 02_void_payment_batch.sql
```
PASS  V1 normal void (res.voided=true reversed=2 A=0.00/pending B=0.00/pending originals_kept=2 reversals=2 net_alloc=0.00 batch=true/wrong amount entered/tester)
PASS  V6 event rows written (1 payment.record + 2 payment.void with reason+actor)
PASS  V1b void entry appended to payment_history on both invoices
PASS  V2 double void rejected (Payment batch already voided; allocation rows still 4)
PASS  V3 blank reason rejected (A reason is required to void a payment)      <- input ''
PASS  V3 blank reason rejected (A reason is required to void a payment)      <- input '   '
FAIL  V3 blank reason accepted                                               <- input E'\t\n' (tab+newline)  NEW DEFECT
PASS  V3 NULL reason rejected (A reason is required to void a payment)
FAIL  V3b batch voided despite blank reason                                  <- consequence of the tab+newline void
PASS  V4 unknown batch rejected (Payment batch not found)
PASS  V5a paid -> partial after voiding the 400 batch (600.00/partial)
PASS  V5b partial -> pending after voiding the rest (0.00/pending)
KNOWN-GAP  V7 (finding 44) voided an overpaid receipt; tenant_credits for that batch still net 300.00 with 0 reversal rows (orphan credit)
PROBE  P1 void of a 500 allocation when invoice paid_amount was edited to 200 -> stored -300.00/pending (NEGATIVE paid_amount accepted, no floor / no drift check)
PROBE  P2 void when invoice status is verifying (paid_amount 500 -> 0) -> stored 0.00/verifying (status left as verifying)
```
Summary: 10 PASS, 1 KNOWN-GAP (V7 finding 44), 2 FAIL (same new defect: whitespace-only reason made of tab/newline is accepted), 2 PROBE.
(Within the file the V3 tab+newline FAIL line is the one without a "rejected" message; the labels above carry the input in the trailing comment added here.)

## 03_append_only_and_uniqueness.sql
All 44 asserted cases PASS (M1-M3, A1-A10, T1-T9, R1-R12, L1-L10), including the exact messages:
- money_events / adjustments / tenant_credits / late_fee_* UPDATE or DELETE -> `<table> is append-only`
- refund_payouts: DELETE -> `refund_payouts is append-only (void instead)`; plain UPDATE -> `only a void is allowed`; second void and un-void -> `refund payout already voided`; void changing another column -> `refund_payouts: only void columns may change`; blank void reason -> `refund_payouts_void_consistent`; duplicate key -> `refund_payouts_idempotency_key_unique`
- adjustments: duplicate reversal -> `uq_adjustments_single_reversal`; duplicate reference_key -> `uq_adjustments_reference_key`
- late_fee_charges duplicate posting -> `uq_late_fee_charge_period`; new policy_version for the same period is accepted (L2)
```
PROBE  P1 adjustments.reason = tab+newline only was ACCEPTED (btrim strips spaces only; blank-reason CHECK bypassed)
PROBE  P2 refund_payouts void_reason = tab only was ACCEPTED (same btrim weakness)
```

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
