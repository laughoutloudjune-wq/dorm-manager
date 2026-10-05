# Notes for the external auditor

(File name kept for old links.) Status: October 2026, feature branch, nothing applied to production. Check these first.

## Design decisions to check
- Global lock order in every money function (0000-0800 and 0650): tenant row, then room row, then invoice rows in ascending id, then every other row. Look for any path that takes locks in another order (deadlock risk), especially `record_payment_batch`, `void_payment_batch`, `final_settle_move_out`, `void_move_out_settlement`.
- Carry-forward helpers in `20261002000000`: `money_carried_in_settled`, `money_downstream_ids`, `money_rederive_downstream`, `money_derive_invoice_status_cf`, `money_late_fee_amount`. Payments, voids and settlement re-derive every downstream carry-forward invoice in the same transaction (event `invoice.status_rederive`).
- Advance rent is never refundable (owner decision): applied as credit at move-out, the rest is absorbed. Refund due = deposit left + unapplied credit only.
- Receipts and allocations are append-only; mistakes are voided with reversing rows. Receiving account is frozen in `payment_method_snapshot`.
- Late-fee approval mode starts only when a `late_fee_policies` row exists; with none, the old automatic behaviour is unchanged.
- Refund and settlement reversal (`0650`) are owner-only permissions (`refund.record`, `settlement.void`) and refuse unsafe cases (live payout, room re-let, final invoice paid, negative invoice).

## TypeScript and SQL twins that must stay in step
| TypeScript | SQL |
|---|---|
| `calculateLateFeeAmount` (`lib/invoice-ledger.ts`) | `money_late_fee_amount`; parity fixtures in `lib/money/late-fee-freeze.test.ts` and `supabase/tests/09_late_fee_freeze.sql` |
| `lib/money/carry-in.ts` | `money_carried_in_settled` / `money_derive_invoice_status_cf` |
| `getChainOwnOutstanding` (`lib/invoice-ledger.ts`) | own-outstanding formula inside `final_settle_move_out` |
| payload hash `lib/money/payment-payload-hash.ts` | payload-hash replay check in `record_payment_batch` |
| `lib/money/payment-errors.ts` regexes | the exact refusal strings the SQL raises |

## Known limitations
- Legacy-shaped rows (`paid_amount > total - carry`, meaning paid already includes the carried part) are special-cased in both twins; the heuristic is the weakest point. Production data shape is unverified.
- Concurrency (idempotent replay race, simultaneous void and record) was never tested with two real sessions; tests are single-session, rollback-wrapped, on dorm-test only.
- The browser UI (refunds page, large-payment confirmation, void dialogs) was never run in a browser; only unit tests on pure logic.
- Production state is unverified (grants, `user_roles`, `late_fee_billed_at`, `meter_readings.billing_month` are assumed). `final-schema.sql` is stale.
- `adjustments` table has no writer and is not in `computeInvoiceTotal`; points redemption, late-fee and settlement SQL are tested only on dorm-test.
- `approve_paid` skips the slip guard when the chain is already settled; web-admin `update_status` to paid is still allowed (findings 61, 76).
- No automated tests for API routes.
