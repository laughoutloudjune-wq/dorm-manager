# Reserved for Opus: atomic database functions and move-out settlement

Decision (user, 2026-10-03): the atomic database functions and the move-out settlement logic are written/reviewed by Opus, not by Sonnet. Sonnet work on these has been stopped.

## Already on `main` (written by Sonnet - Opus should review before production)
- `supabase/migrations/20261002000000_migration-money-events-and-void-payment.sql` - `void_payment_batch()`, `money_events`
- `supabase/migrations/20261002000500_migration-record-payment-batch.sql` - `record_payment_batch()`; wired from `applyInvoicePaymentAllocation` and `applyManualInvoicePaymentAllocation` in `lib/invoice-ledger.ts`
- Both were tested only with rollback-wrapped scenarios on the dummy project `dorm-test`.
- Known open items on `record_payment_batch` (see findings 34-36): verify every invoice belongs to `batch.tenant_id`; STALE_INVOICE should also guard `payment_history`; round amounts to 2 decimals in the auto path before the RPC.
- `lib/money/settlement.ts` (planner, 16 tests) exists as pure logic and is NOT wired to the move-out routes.

## Stopped, unmerged branches with partial work (reference only)
- Atomic final move-out settlement: branch `worktree-agent-adb3a1653e91d5b38` (migration number reserved: 20261002000600)
- Atomic points redemption/reversal: branch `worktree-agent-a92576f0b35999e80` (20261002000700)
- Late-fee post/waive functions: branch `worktree-agent-ae1e0ba69c875d367` (20261002000800)
Planner/spec inputs: `lib/money/settlement.ts`, `lib/money/points-redemption.ts`, `lib/money/late-fee.ts`, migrations 20261002000100-400.

## Still Sonnet-safe (not reserved)
Screens, CSV/report labels, tenant/admin displays, permission wiring, non-atomic route logging, operator guide, audit brief.

## Added open item (from docs review)
- `void_payment_batch` must also reverse the `tenant_credits` 'overpayment' row created by `record_payment_batch` for the same batch (finding 44), otherwise voiding an overpaid receipt leaves orphan credit.
