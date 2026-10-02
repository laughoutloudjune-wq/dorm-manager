# Read-only production financial integrity audit

**As of:** 2 October 2026 (Asia/Bangkok)  
**Repository:** `laughoutloudjune-wq/dorm-manager`, default branch `main`  
**Production project inspected:** Supabase `ApartmentFlow` (`hunofnfolufasvsmcwby`), PostgreSQL 17.6.1  
**Scope:** Read-only schema, migration, advisor, and targeted reconciliation queries. No production writes, migrations, source edits, or data corrections were made.

## Sources and limits

Read [the 29 September late-fee and overdue design](2026-09-29-late-fee-and-overdue-design.md), which sets the 25 October 2026 cutover and preserve-history decisions, plus the recent Git history and the 30 September/1 October payment, balance-engine, and move-out changes. The GitHub connector exposed individual files but not a directory listing, so I could not confirm that every other file in `docs/audit/` was read. The deployed web application revision was not available to compare with `main`; findings about application routes below are therefore code-history evidence, not proof of the live deployment.

## Ranked findings

1. **Sensitive Storage buckets are public — urgent exposure.** Production marks all four buckets public: `contracts`, `payment_slips`, `payment-methods`, and `tenant-docs`. Public URLs can bypass table RLS; payment slips, contracts, and tenant documents should be treated as exposed until access is checked. Preserve existing files and links while planning a controlled private-delivery cutover.

2. **The live v2 fee tag is ahead of the agreed cutoff.** All 51 v2 invoices are for the September 2026 billing period, issued 25 September and due 10 October. The design and current balance-engine comments say the new model starts with bills made on 25 October. This may be a pilot or tagging error; confirm the intended treatment before changing any invoice or generating October bills.

3. **Calculated move-out credits have no refund-payment records.** There are 9 completed move-out requests and 0 rows in `refunds`. Seven negative move-out invoices total ฿24,770; excluding the 116/1 ฿1,500 credit leaves exactly the known ฿23,270 target. This is a strong reconciliation lead, not proof that any refund was paid or remains unpaid. Keep “refund calculated” separate from “refund paid.”

4. **Legacy invoice paid caches do not reconcile to allocations.** 22 mismatches are all legacy invoices; `paid_amount` exceeds allocation totals by ฿55,902 net (฿80,910 sum of absolute differences). This matches the source comment identifying 22 pre-allocation legacy rows. The 497 active batches and their 504 allocations otherwise reconcile exactly to ฿1,822,299; there are no orphan allocations or voided batches. Do not rewrite these historical rows. Cash reporting should use non-voided batches/allocations, not sum `invoices.paid_amount`.

5. **The new money-event audit log is not recording events.** The 1 October migration is applied and `money_events` exists, but it has 0 rows. Production `record_payment`, `void_payment`, `settle_move_out`, and `mark_refund_paid` do not reference it, and no triggers were found on the financial tables. The event-log feature is schema-only today.

6. **The ฿8,000 unbilled-fee target is not yet reconciled.** A conservative scan finds four legacy rows with positive `locked_late_fee_amount` and no `late_fee_billed_at`, totalling ฿9,500 (rooms 112/1, 114/1, and two 212/2 bills). Some are marked paid and amounts may be historical or otherwise settled; this is not a collectible-balance assertion. Resolve the difference against the original case list and fee-line breakdowns before treating it as debt.

7. **The lockdown is partial but base financial tables are not directly exposed to API roles.** All 29 public tables have RLS enabled and no policies; `anon` and `authenticated` have no SELECT on invoices, batches, allocations, refunds, roles, or meter staff. Payment RPCs are invoker functions executable by `service_role`, not those client roles. However, `v_room_reconciliation` is readable by both client roles and reveals room identifiers/status. Supabase also reports leaked-password protection disabled. The database no longer shows direct table access for self-activation, but the live server-route authorization was not independently verified.

8. **Application reporting and receipt gates remain deployment checks.** The repository history says the balance engine is intended across dashboards/reports/receipts and that reports exclude voided payments; the database totals support allocation-based collections. The live dashboard query, receipt eligibility’s link to payment batches, LINE webhook redelivery’s reuse of a stable idempotency key, and deployed route revision were not directly verified. The public storage condition also weakens slip confidentiality regardless of receipt logic.

## What is already correct

- Production migration history includes `record_payment`, `void_payment`, the monthly-invoice uniqueness rule, and the money-events table.
- `record_payment` requires a nonblank idempotency key and actor, a positive explicit amount, exact split-to-received equality, locks the tenant row, checks replay/conflict, and rejects `admin_status_paid`. A partial unique index enforces per-tenant idempotency keys. All 19 batches created since the payment-RPC migration have keys; 104 keyed batches have no duplicate tenant/key. The 393 earlier batches without keys are historical.
- The database function requires a slip for `admin_liff_approve`; all 69 batches with that source have a nonempty slip and positive received amount. This validates stored evidence and database checks, but not the deployed LIFF handler.
- Repository history says `update_status` writes status only and does not create payments; the later LIFF approval path requires a reviewed slip. In production, the 9 `paid` invoices with `paid_amount=0` all have zero or negative totals (8 move-out credits and one monthly credit); none is a positive-total invoice marked paid with zero paid amount.
- For 109/1, the July/August/September legacy totals are ฿2,867 + ฿5,758 + ฿8,666, with carried-in amounts of ฿0 + ฿2,867 + ฿5,758. The underlying own charges total ฿8,666, consistent with the design’s no-double-counting example.

## Minimal prioritized plan

1. **Contain and verify access:** inventory public object URLs; privately serve slips/contracts/tenant documents with authorized, short-lived links; test current upload, tenant, admin, and receipt flows before rollout. Remove the public reconciliation view grant or make it security-invoker after checking consumers.
2. **Set the cutover explicitly:** decide whether the 51 September v2 bills are an intentional pilot. Keep them unchanged; verify the first October 25 batch is v2 and the legacy generator cannot touch it.
3. **Complete the money trail:** write one immutable event in the same transaction as each payment, void, settlement, and refund-paid action; validate event-to-batch/allocation reconciliation on a staging copy first.
4. **Make reports allocation-led:** use received batches and non-void allocations as the collections source; show refunds as a separate outflow and qualify calculated-but-unpaid refunds.
5. **Resolve old cases by evidence, not bulk recalculation:** review the 22 legacy exceptions, the ฿23,270 move-out-credit lead, and the ฿8,000/฿9,500 fee discrepancy against slips, bank transfers, and source invoice breakdowns. Record any approved correction as a new, linked adjustment; retain original rows.
6. **Rollout and rollback:** ship behind a feature gate; compare daily totals and per-tenant balances against the read-only reconciliation for one cycle; pause new writes to the affected flow and revert the application deployment if totals or access checks fail. Do not use destructive data migrations as rollback.
