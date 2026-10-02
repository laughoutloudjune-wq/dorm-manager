# Money-system findings (running report)

Discovered while implementing the money-system plan. Each entry: what, where, why it matters, what needs doing.
No production data has been changed for any of these.

| # | Finding | Where | Why it matters | Needed |
|---|---------|-------|----------------|--------|
| 1 | Payment deletion hard-deletes the receipt and its allocations | `app/api/admin/invoices/actions/route.ts` `delete_payment_batch` | Original financial event is erased; `paid_amount` is left unchanged, so balance and allocations diverge (it only returns a "mismatch" warning) | Replace with void/reverse (migration `20261002000000`) |
| 2 | `record_payment` accepts a raw `payload` and writes it straight to `invoices` | same file, `record_payment` fallback branch | Any field, including `paid_amount`/`total_amount`/status, can be changed with no event | Remove or whitelist the branch; log before/after |
| 3 | `update_status` writes `locked_late_fee_amount` (freeze/unfreeze) and triggers fee billing and points sync | same file, `update_status` | Status change has monetary side effects, against the plan's rule 1 | Make status change write status only |
| 4 | `delete_many` hard-deletes invoices | same file, `delete_many` | Invoice with allocations/history can vanish without an adjustment event | Block when money exists, or require cancel + reason |
| 5 | `money_events` helper existed untracked with no table and no callers | `lib/money-events.ts` | Audit log silently failing | Table added in migration `20261002000000`; callers being wired |
| 6 | Reconciliation has only invoice-level checks | `lib/reconciliation.ts` | Plan Phase 8 needs batch/allocation/credit/refund/points checks | Extend, then add admin review view |
| 7 | Invoice UI "cancel payment entry" edited `paid_amount`, history and status directly from the browser's computed values, and recomputed status as `paid` when `paid >= total` | `lib/hooks/use-invoices-state.ts` `cancelPaymentEntry` | Bypassed allocations/receipts entirely; legacy history entries with no `payment_batch_id` can no longer be cancelled automatically | Rerouted to `void_payment`; legacy entries need a manual adjustment path (Phase 3 adjustments) |
