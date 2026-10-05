# Money lifecycle: what is authoritative, what is derived

Status October 2026, feature branch. **Nothing is applied to production.** Verified only on dorm-test (SQL scripts) and by unit tests; UI not run in a browser; two-session concurrency untested; production state unverified. See `docs/README-money.md` for migrations and go-live.

Legend: **WIRED** = migration/code exists and a route or screen calls it (still not in production). **FILE ONLY** = exists, tested, but no route calls it. **NOT BUILT** = designed only.

## 1. Lifecycle in one paragraph
An invoice states what a tenant owes. Real money arrives as a receipt (`payment_batches`), split into allocations (`invoice_payment_allocations`), one per invoice. Money held for a tenant (deposit, advance rent, overpayment) is a tenant credit. Money sent back is a refund payout. A mistake is never edited: it is voided (reversing rows) and re-recorded. Every money action writes a `money_events` row.

## 2. Authoritative records
| Record | Role | Status |
|---|---|---|
| `invoices` + `computeInvoiceTotal` (`lib/invoice-total.ts`) | What is owed; the only place a total is computed | WIRED (no adjustments term) |
| `payment_batches` | One real money-in event | WIRED |
| `invoice_payment_allocations` | How a receipt was split; authority for period/date/account | WIRED |
| `tenant_credits` + `tenant_credit_balances` (0200) | Held money: `deposit`, `advance`, `unapplied`; append-only | WIRED (overpayment, move-out, refund) |
| `refund_payouts` + `refund_due_vs_paid` (0300, 0650) | Money actually sent to a tenant | WIRED (refunds route and page) |
| `move_out_settlements` (0600) | Record of a final settlement; reversible by 0650 | WIRED |
| `late_fee_policies`, `late_fee_charges` (0400, 0800) | Approval-mode late fees | WIRED, dormant until a policy row exists |
| `adjustments` (0100) | Discount, waiver, write-off | FILE ONLY, no writer |
| `money_events` | Append-only audit log | WIRED |
| `invoices.payment_history`, `invoices.paid_amount` | Display cache and running balance; never income evidence | WIRED as cache |

Reports read receipts and allocations. "What is owed" screens read the invoice through the engine.

## 3. Recording a payment
Admin `record_payment` / `record_split_payment` or LINE `approve_paid` go through `applyInvoicePaymentAllocation` / `applyManualInvoicePaymentAllocation` (`lib/invoice-ledger.ts`) to `record_payment_batch` (0500): one transaction with idempotent replay (payload hash), tenant-ownership check, stale guard over `paid_amount` and `payment_history`, batch + allocations, overpayment credit, downstream carry-forward re-derivation, money event. Status changes never move money. A typed amount above the invoice's remaining asks for confirmation in the UI (`use-invoices-state.ts`); the server still decides the split and keeps any excess as credit. Expected refusals map to 409/400 (`lib/money/payment-errors.ts`); post-commit steps (notifications, points sync) cannot turn a recorded payment into a 500.

## 4. Carry-forward rule (TS twin `lib/money/carry-in.ts`, SQL `money_carried_in_settled`)
- An invoice is **paid** iff own paid > 0 and own paid + carried-in from SETTLED sources >= total.
- A source is **settled** when paid >= total, or recursively: own paid > 0, not legacy-shaped (`paid_amount > total - carry`, i.e. paid already includes the carried part) and own paid + its settled carried-in >= total.
- **Owed on a row** = max(0, total - carry - paid); legacy-shaped rows owe total - paid.
- Payments, voids and move-out settlement re-derive every downstream carry-forward invoice in the same transaction (`invoice.status_rederive`). If a downstream invoice becomes paid, its late fee is frozen with the same rule and date as the normal path (`money_late_fee_amount`, twin of `calculateLateFeeAmount`; fixtures in `lib/money/late-fee-freeze.test.ts`, `supabase/tests/09_late_fee_freeze.sql`).

## 5. Display rules
Per-invoice "remaining" is 0 when paid or cancelled, else total - paid. Any sum across invoices uses the own-outstanding rule so a carried debt counts once (dashboard, overdue, LIFF total, debtor gates, action queue).

## 6. Invoice total
`computeInvoiceTotal` takes every component (rent, water, electricity, commonFee, nativeLateFee, lateFeeItems, fees, carryForward, discount). Read stored rows through `chargesFromInvoiceRow`, write through `toInvoiceMoneyColumns`. Move-out credit applied to a final bill is a protected `discount_breakdown` line (source `move_out_credit`); invoice edits cannot erase approved late-fee lines or protected discount lines (`lib/money/save-details-guard.ts`). Adjustments are NOT in the engine (NOT BUILT).

## 7. Void
`void_payment` needs permission `invoice.payment.record` and a reason. `void_payment_batch` (0000) appends negative allocations (`reverses_allocation_id`), lowers `paid_amount`, re-derives status and downstream invoices, clears a freeze that no longer applies, refuses settlement/credit batches and cases a refund payout depends on. Originals are never deleted.

## 8. Move-out money (WIRED)
Vacate then settle (see `CLAUDE.md`). Settlement uses `planMoveOutSettlement` (`lib/money/settlement.ts`, `move-out-settlement-input.ts`) and writes through `final_settle_move_out` (0600). **Advance rent is never refundable**: applied as credit at move-out, the rest absorbed. Refund due = deposit left + unapplied credit.
- `record_refund_payout` (0650): only after a live settlement; capped at refund due; needs method, recipient, and a reference or evidence; idempotent per key; owner-only permission `refund.record`.
- `void_refund_payout`: reason required.
- `void_move_out_settlement` (permission `settlement.void`, owner-only): atomically reverses credit payments on older invoices, deposit/advance entries, cancels the final invoice, restores tenant and room. Refuses when a payout is live, the room is re-let, the final invoice has been paid, or an invoice would go negative.
- UI `app/(admin)/credits-refunds/page.tsx`, `components/admin/refunds/*`; API `app/api/admin/refunds/actions/route.ts`. Not run in a browser.

## 9. Late fees
Legacy path: calculated once when an invoice is fully paid or carried forward, frozen in `locked_late_fee_amount`, shown on the next invoice. Approval flow (post, waive, reverse, policy; `app/api/admin/late-fees/actions`, 0800) starts only when a `late_fee_policies` row exists; with none the legacy behaviour is exactly unchanged.

## 10. Points
`redeem_points_atomic` / `reverse_points_redemption` (0700), used from `lib/points-ledger.ts`.

## 11. Reconciliation and tooling
Nine read-only checks (`lib/money/reconciliation-checks.ts`), reconciliation page, action queue, discrepancy script (`scripts/discrepancy-report.ts`). They fix nothing.

## 12. Not built / not verified
Adjustments writer and engine term; void of legacy payment-history entries with no batch; LINE admin dashboard basis labels; tenant display of credit and refunds; browser UI run; two-session concurrency tests; production schema diff. Known loose ends: `approve_paid` on an already-settled chain skips the slip guard, and web-admin `update_status` to paid is still allowed (findings 61, 76).
