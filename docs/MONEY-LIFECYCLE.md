# Money lifecycle: what is authoritative, what is derived

Status as of 2026-10-03, repo state after commit `d9923d7` (`main`). **Nothing has been applied to production**: none of the `20261002*` migrations has been run there (they are files; see `docs/README-money.md` for the go-live order and `docs/money-rewrite-plan.md` for the checklist). They were exercised only on the dummy project `dorm-test`, which has a few gaps against production (`docs/TEST-SCHEMA-GAPS.md`).

Legend used throughout:
- **IMPLEMENTED**: code exists in the repo and is wired into a route or screen.
- **FILE ONLY**: migration or pure planner exists and is tested, but is not applied to production or not called by any route or screen.
- **DESIGNED**: described here, no code yet.
- **OPUS**: reserved for Opus review or authorship (`docs/OPUS-HANDOFF.md`). Sonnet must not change it.

## 1. The lifecycle in one paragraph

An invoice states what a tenant owes (a charge). Real money arrives as a receipt (a `payment_batches` row), which is split into allocations (`invoice_payment_allocations` rows), one per invoice it settles. Anything that changes what is owed without money arriving (discount, waived fee, write-off, correction) is an adjustment. Money held for a tenant (deposit, advance rent, unapplied overpayment) is a tenant credit. Money sent back to a tenant is a refund payout. A mistake is never edited; it is reversed by a new row (void) and then re-recorded. Every money-affecting action writes a `money_events` row.

## 2. Which record is authoritative

| Record | Table / code | Role | Status |
|---|---|---|---|
| Charge ledger | `invoices` + `computeInvoiceTotal` in `lib/invoice-total.ts` | What the tenant owes. `total_amount` is derived from the charge components, never hand-added. | IMPLEMENTED (adjustments term missing, see section 4) |
| Receipt | `payment_batches` | One real money-in event: amount received, `paid_at`, slip, source, receiving-account snapshot. Authoritative for "money received". | IMPLEMENTED |
| Allocation | `invoice_payment_allocations` | How a receipt was split across invoices. Authoritative for which invoice/period received how much, when, into which account. | IMPLEMENTED |
| Adjustment | `adjustments` (`20261002000100`) | Signed, reasoned, append-only: discount, waiver, correction, write_off, reversal. | FILE ONLY. No route writes it; the invoice total does not read it. |
| Tenant credit | `tenant_credits` + view `tenant_credit_balances` (`...000200`) | Money held, in buckets `deposit`, `advance`, `unapplied`. Append-only. | FILE ONLY, except that `record_payment_batch` writes an `overpayment` / `unapplied` row when a receipt exceeds the open balance. |
| Refund payout | `refund_payouts` + view `refund_due_vs_paid` (`...000300`) | Money actually sent to a tenant. One void allowed per row, never deleted. | FILE ONLY |
| Late-fee charge / policy | `late_fee_charges`, `late_fee_policies` (`...000400`), `lib/money/late-fee.ts` | A posted fee as its own explainable row; versioned policy. | FILE ONLY. Live late fees still use `calculateLateFeeAmount` and `locked_late_fee_amount` in `lib/invoice-ledger.ts`. |
| Audit log | `money_events` (`...000000`), `lib/money-events.ts` | Append-only before/after log with actor and reason. | IMPLEMENTED for payment record, payment void, status change, the edit/delete paths in the admin and admin-LIFF invoice routes, slip submit/approve/decline, `sync_period_statuses` and invoice generation (batch logging, `lib/money-events.ts`). Still unlogged: `sync_overdue`, points revert snapshot, slip-decline internals (findings 60, 82). |
| `payment_history` (JSON on invoices) | `invoices.payment_history` | **Display projection only.** A cache for the UI. Never a source for reports or balances. | IMPLEMENTED as a cache. Reconciliation check `payment_history_mismatch` compares it to allocations. |
| `invoices.paid_amount` | column | Running balance per invoice. Not an income figure and not evidence of when money arrived. Reconciled against the sum of allocations (`invoice_paid_vs_allocations`). | IMPLEMENTED |

Rule of thumb: reports of money read receipts and allocations. Screens of "what is owed" read the invoice through the engine. `payment_history` is shown, never summed.

## 3. How a payment is recorded (IMPLEMENTED)

1. Admin action `record_payment` or `record_split_payment` (`app/api/admin/invoices/actions/route.ts`) calls `applyInvoicePaymentAllocation` / `applyManualInvoicePaymentAllocation` in `lib/invoice-ledger.ts`.
2. TypeScript computes the split (oldest-first through the carry-forward chain, or the admin's manual split), the new `paid_amount`, status and history entry.
3. It calls the database function `record_payment_batch(jsonb)` (`20261002000500`, **OPUS**), which in one transaction: replays on a duplicate `(trigger_invoice_id, idempotency_key)`; locks each invoice and refuses with `STALE_INVOICE` if `paid_amount` is no longer what the caller read; inserts the batch; updates invoices; inserts allocations; adds an `overpayment` tenant credit for any excess of received over allocated; writes a `payment.record` money event.
4. A raw payload to `record_payment` may only touch `slip_url`, `slip_uploaded_at`, `payment_history`. Money columns are rejected with HTTP 400.

Changing an invoice status never moves money (see `CLAUDE.md`). Money is recorded only by `record_payment`, `record_split_payment`, and `approve_paid` (LINE admin; needs a slip and `verifying` status).

Planner note: `lib/money/allocation.ts` (`planReceiptAllocation`) is tested pure logic but no route calls it yet; the routes still use the older in-ledger calculation. FILE ONLY.

LINE admin `approve_paid` (`app/api/admin-liff/invoices/actions/route.ts`) now takes the admin's **confirmed amount and transfer date** (validated by `lib/money/slip-approval.ts`), requires `verifying` plus a non-empty `slip_url`, and records through `applyInvoicePaymentAllocation` with `keepExcessAsCredit`. It no longer passes `Number.MAX_SAFE_INTEGER`. LIFF `update_status` to `paid` is rejected. Remaining loose end: when the chain has nothing outstanding the route only sets status `paid` and returns before the slip guard (finding 76). Web-admin `update_status` to `paid` is still allowed as a label (finding 61).

## 4. Invoice total and balance

- Total: `computeInvoiceTotal(charges)` in `lib/invoice-total.ts` is the only place a total is calculated. Every component is a required field: rent, water, electricity, commonFee, nativeLateFee, lateFeeItems, fees, carryForward, discount. Stored rows are read through `chargesFromInvoiceRow` and written back through `toInvoiceMoneyColumns`, so the overlapping `late_fee_amount` and `additional_fees_total` columns are never added twice.
- Balance of one invoice: `total_amount - paid_amount`. A payment is allocated across the whole carry-forward chain, so the chain's real outstanding is the authority when recording (see `CLAUDE.md`).
- Voided receipts still exist, but their negative reversal allocations net them to zero in any sum.
- **DESIGNED, not built:** an adjustments term in `computeInvoiceTotal` (finding 12). Until it exists no writer may use the `adjustments` table, otherwise a recorded adjustment would not change what the tenant owes. The `discount` field (rent round-down, points redemption) is the only discount mechanism today.

## 5. Non-cash settlement methods (labels, never cash)

A non-cash settlement reduces what is owed but moves no money into a bank account. It must never be counted as cash received, must never be given a receiving account, and must be labelled as non-cash.

| Method | Meaning | State today |
|---|---|---|
| Deposit credit / advance-rent credit applied | Tenant's held deposit or prepaid rent used against an invoice | Partly IMPLEMENTED: `abandon_room` in `app/api/admin/tenants/actions/route.ts` calls `applyInvoicePaymentAllocation` with `source: "abandon_room"` and snapshot `{type:"credit"}`. `paymentSourceLabel` renders it as a non-transfer credit, and `isNonCashPaymentSource` (covers `abandon_room` and `credit`) hides the account control. The `tenant_credits` `applied_to_invoice` rows are DESIGNED, not written by this path. |
| Points redemption | Reward points turned into an invoice discount | Old version IMPLEMENTED in `lib/points-ledger.ts` (`redeemPoints`; writes the discount directly, not atomic). Planner `lib/money/points-redemption.ts` is FILE ONLY. The atomic DB function is OPUS. |
| Write-off | Debt forgiven | DESIGNED: `adjustments.type = 'write_off'` exists as a table only. |
| Waiver of a fee | A late fee cancelled | Existing column `waived_late_fee_amount`; the `waiver` adjustment type is DESIGNED. |

An `abandon_room` credit is still a real `payment_batches` + allocation row (finding 58). It is now excluded from cash totals: `summarizeAllocations` in `lib/money/report-definitions.ts` splits cash from non-cash, the per-account breakdown in `ReportsPageView` skips credit rows, and the dashboard and daily digest use the same summariser. The row itself still appears in the cash rows list with a label. Verify with real data before relying on it (finding 43 was the original gap).

## 6. Receiving-account snapshot rule (IMPLEMENTED)

The receiving account is frozen at payment time in `payment_method_snapshot` (a full JSON copy on the batch and on every allocation). It is resolved once, by `resolvePaymentMethodForTenant` in `lib/invoice-ledger.ts`, and never re-derived from `tenants.custom_payment_method` or the default `payment_methods` row. Rows older than the snapshot have `NULL` and are reported as unknown (`paymentMethodSnapshotLabel`; reconciliation check `missing_account_snapshot`). Non-cash sources carry a `credit` snapshot, not a bank.

## 7. Void and reversal model (IMPLEMENTED, OPUS to review)

- Admin action `void_payment` (the alias `delete_payment_batch` no longer deletes) needs permission `invoice.payment.record` and a written reason. The invoice modal and the invoices hook ask for confirmation and a reason.
- Database function `void_payment_batch` (`20261002000000`): locks the batch; refuses a second void; for each original positive allocation inserts a negative allocation with `reverses_allocation_id` (unique, so one reversal each); lowers `invoices.paid_amount`; downgrades a `paid` or `partial` invoice to `partial` or `pending` if it no longer covers its total; appends a `void` entry to `payment_history`; writes a `payment.void` money event per invoice; stamps the batch `voided_at/by/reason`. The original receipt and allocations are never deleted.
- Correction = void, then record the right payment again. Never edit `paid_amount`.
- Gaps: voiding does not reverse a `tenant_credits` `overpayment` row created by the same batch; legacy history entries with no `payment_batch_id` cannot be voided and need an adjustment (DESIGNED). Adjustments and tenant credits follow the same pattern (a new `reversal` row pointing at the original, at most once) but have no writer yet.

## 8. Late fees

IMPLEMENTED (legacy): calculated once when an invoice is fully paid or carried forward, locked in `locked_late_fee_amount`, shown as a line item on the next invoice. A status change does not touch it. `save_details` still nulls `locked_late_fee_amount` in one case (finding 29).
FILE ONLY: versioned policies, posted charges with a unique key, waiver events (`lib/money/late-fee.ts`, migration `...000400`). The approval flow is DESIGNED.

## 9. Move-out money (FILE ONLY, OPUS)

`lib/money/settlement.ts` plans a final settlement: final bill, older debt, advance rent consumed before deposit, forfeiture needs a reason, refund due is never negative, payouts may not exceed refund due. It is not wired to the move-out routes. The atomic settlement function is reserved for Opus (stopped branch `worktree-agent-adb3a1653e91d5b38`, number `20261002000600`).

## 10. Reconciliation (IMPLEMENTED, report only)

`lib/money/reconciliation-checks.ts` runs nine checks: batch vs allocations, invoice paid vs allocations, orphan allocation, batch without allocations, payment history mismatch, status vs balance, carry forward, missing money event, missing account snapshot. `GET /api/admin/reconciliation` (permission `reconciliation.view`, loader shared in `lib/money/reconciliation-loader.ts`) and the admin page `/reconciliation` show the findings with a CSV export and deep links to the invoice and tenant. The action queue (`/action-queue`, `action_queue.view`, `lib/money/action-queue.ts`) shows the same findings next to slips, estimated late fees, refunds due and unapplied credits. Neither fixes anything.

Read-only discrepancy report: `scripts/discrepancy-report.ts` (`npm run report:discrepancies`, logic in `lib/money/discrepancy-report.ts`) runs the same checks over the whole database from the owner's machine, with a read-only client wrapper and `--redact`. See `docs/DISCREPANCY-REPORT-HOWTO.md`.

## 11. Reserved for Opus

- `supabase/migrations/20261002000000_migration-money-events-and-void-payment.sql` (`void_payment_batch`)
- `supabase/migrations/20261002000500_migration-record-payment-batch.sql` (`record_payment_batch`), with open items 34-36 in `docs/money-system-findings.md`
- Atomic final move-out settlement, atomic points redemption/reversal, late-fee post/waive functions (stopped branches listed in `docs/OPUS-HANDOFF.md`)
- Wiring `lib/money/settlement.ts` into the move-out routes

## 12. Implemented versus designed-but-not-built (summary)

| Area | Built and wired (code on main) | File only / pure logic, not wired | Designed, not built |
|---|---|---|---|
| Recording | `record_payment`, split payment, atomic `record_payment_batch`, idempotency, stale guard, overpayment credit, LINE `approve_paid` with confirmed amount and date | `planReceiptAllocation` | Server dry-run of a payment |
| Reversal | `void_payment` via `void_payment_batch`, reason required, UI confirm | none | Void reversing the overpayment credit (Opus); void of legacy entries |
| Audit | `money_events` on record, void, status, edit, delete, slip events, period sync, generation | none | Logging for `sync_overdue`, points revert, slip decline internals |
| Slips | Slip states (`lib/money/slip-states.ts`, badge), decline with reason, approval validation | none | Archive of replaced slips |
| Late fees | Legacy locked fee; estimate shown in tenant statement and action queue | `lib/money/late-fee.ts`, `late_fee_charges`, `late_fee_policies` | Post and waive with approval (Opus) |
| Adjustments, write-offs, waivers | Ledger view shows 0 | `adjustments` table | Writer, and an adjustments term in `computeInvoiceTotal` |
| Credits and refunds | Overpayment credit row; action-queue sections read `tenant_credit_balances`, `refund_due_vs_paid` | `tenant_credits`, `refund_payouts`, views | Credit application to invoices, refund payout recording, tenant display |
| Move-out | Legacy vacate and settle routes | `lib/money/settlement.ts` | Atomic settlement and wiring (Opus) |
| Points | Legacy non-atomic `lib/points-ledger.ts` | `lib/money/points-redemption.ts` | Atomic redemption and paired reversal (Opus) |
| Screens | Reconciliation page, action queue, invoice Payments tab with ledger view, void and discrepancy notice, deep links, nav gating by permission, tenant statement on payment link and LIFF list, receipts show reversals | none | LIFF invoice list on statement for paid rows, refund due vs paid view |
| Reports | `report-definitions.ts` cash vs billing labels; Reports page toggle; web dashboard and daily digest from receipts | none | LINE admin dashboard labels (finding 68) |
| Tooling | Discrepancy report script, dorm-test project, scenario suite `lib/money/scenarios.test.ts` | none | Production schema export and diff |
