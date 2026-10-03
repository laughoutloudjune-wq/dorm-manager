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

## Additional context for the reviewer (added after the docs sync)
- Findings 61 and 76 (`approve_paid` settled-chain branch skips the `verifying` + `slip_url` guard; admin `update_status` -> paid still allowed) touch payment flows and should be considered with the atomic function review.
- Finding 98: `refund_due_vs_paid` excludes advance rent from refund due; confirm the rule with the owner before changing the view.
- SQL test scripts for the atomic functions are in `supabase/tests/` once merged (the known-gap cases are intentionally failing).

## From the SQL test run (supabase/tests/RESULTS.md on dorm-test)
Findings 105-108 are defects in the atomic functions found by the rollback-wrapped tests: whitespace-only reasons accepted, excess dropped when tenant_id is NULL, allocations/paid_amount not validated, void can drive paid_amount negative. Known-gap cases (35, 36, 44) are intentionally failing in the scripts.

## Owner decision (2026-10-03)
Advance rent is NOT refundable. At move-out it is applied as credit; it never becomes refund due. Check `lib/money/settlement.ts` (`planMoveOutSettlement`) honours this: refund due may come only from the security deposit (and unapplied overpayment credit).

## Status of the SQL review fixes (stopped early by the owner to save usage, 2026-10-03)
Merged on main (commit 906ffbd): REVOKE/GRANT + search_path on 0600/0800, payload-hash replay conflict, lock-order and void-guard changes in 0000/0500/0600/0700/0800, TS payload hash (`lib/money/payment-payload-hash.ts`).
NOT verified: the merged SQL has not been re-applied to dorm-test and the full `supabase/tests` suite has not been re-run since these edits. The agent was mid-way through restructuring `record_payment_batch`'s lock set and pre-checks; its uncommitted edits to migrations 0000, 0500, 0600 are only in worktree `.claude/worktrees/agent-a78fa26f4f033000a` (reference only, may be half done).
Remaining from findings 138-156 and 174: (a) re-apply 0000-0800 to dorm-test and run all test scripts incl. privilege tests as anon/authenticated; (b) 0500 paid-status rule counting carried-in amounts for carry-forward targets (finding 174); (c) the single 'paid' rule across record/void/settle; (d) void clears `locked_late_fee_amount`, refuses settlement/credit batches, accounts for refund payouts; (e) `post_late_fee_charge` lock on the source invoice and setting `late_fee_billed_at`; (f) rollback notes; (g) the README go-live list for 0000-0800 (docs/README-money.md still lists only 0000-0500).
