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

## 06_late_fee_actions.sql (late-fee approval flow, migration 20261002000800)
Run 2026-10-03 on dorm-test (rghxelkifdrpvabyxopb) only, rolled back (post-run check: 0 fixture tenants, 0 policies,
0 charges, 0 late-fee adjustments, 0 `late_fee_flow` events left). Functions as in 20261002000800 (applied to dorm-test as
migrations `late_fee_actions_20261002000800` + `late_fee_actions_whitespace_reasons`; the second makes the blank checks
strip tab/CR/LF as well as spaces, matching the file).
```
PASS  P1 policies are new versions (v1, v2), auto_post defaults false, old version unchanged, event logged
PASS  P2 editing an existing policy rejected (late_fee_policies is append-only)
PASS  L1 post: distinct linked late_fee_line, columns +150, charge row, audit event (cols=3350.00/150.00/350.00 line=1 charge=1 event=1 engine=true)
PASS  L2 duplicate post replayed the original (charges=1, total still 3350)
PASS  L2b same key with a different amount rejected (DUPLICATE_CHARGE_DIFFERENT)
PASS  L3 overlapping period rejected (OVERLAPPING_CHARGE)
PASS  L4 stale target total rejected, nothing written (STALE_INVOICE)
PASS  L5 columns not equal to current+fee rejected (INCONSISTENT_COLUMNS)
PASS  L6 2 days x 50 cannot post 500 (AMOUNT_EXCEEDS_RATE)
PASS  L7 150 posted + 1000 over the 1000 cap rejected (CAP_EXCEEDED)
PASS  L8 automation refused when policy auto_post=false (AUTO_POST_DISABLED)
PASS  L9 cross-tenant target rejected (TENANT_MISMATCH)
PASS  L10 charge rate must match its policy version (RATE_MISMATCH)
PASS  L11 paid target rejected (TARGET_NOT_OPEN)
PASS  L12 target whose total disagrees with the totals engine rejected (ENGINE_MISMATCH)
PASS  W1 blank reason [] rejected (REASON_REQUIRED)
PASS  W1 blank reason [   ] rejected (REASON_REQUIRED)
PASS  W1 blank reason [\t\n] rejected (REASON_REQUIRED)
PASS  W1b blank approver rejected (APPROVER_REQUIRED)
PASS  W2 waiver of 151 on a 150 fee rejected (WAIVER_EXCEEDS_FEE)
PASS  W2 waiver of 99999999 on a 150 fee rejected (WAIVER_EXCEEDS_FEE)
PASS  W3 waiver 100 of 150: adjustments row (reason+approver), line 150/100/50, columns -100, engine ok
PASS  W4 retried waiver replayed (1 adjustment)
PASS  W5 second waiver of 60 with only 50 left rejected (WAIVER_EXCEEDS_FEE)
PASS  R1 reversal with blank reason rejected (REASON_REQUIRED)
PASS  R2 reversal: paired -100 row, original waiver kept, net waived 0, line back to 150, total 3350
PASS  R3 second reversal replayed (1 reversal row)
PASS  R4 waiver rows cannot be deleted (adjustments is append-only (post a reversal instead))
PASS  T1 target total = engine identity, and late-fee lines = charges - net adjustments (150.00)
PASS  T2 source invoice untouched (fee lives on the later invoice only)
PASS  A1 historical invoice needs admin approval even under auto_post (AUTO_POST_HISTORICAL)
PASS  A2 automation posts under an auto_post policy and is logged as automation:test
```
Summary: 32 PASS, 0 FAIL. Not exercisable single-session: two concurrent posts racing on the same key (the target-row
lock and the unique key are the arbiters; needs two connections).
