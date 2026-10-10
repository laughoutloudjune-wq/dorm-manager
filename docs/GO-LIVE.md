# Go-live checklist (production)

> **STATUS 2026-10-10: step 0 and step 1 (database) are DONE** — see `docs/PRODUCTION-APPLIED-20261010.md`. What remains is step 2 (deploy the app) and step 3 (checks after deploy).

Nothing in this branch has ever been applied to production. Do this in one quiet window (late evening), about 1–2 hours. The database changes and the app deploy go together: do them back to back, database first. Do not leave the new database running under the old app for days, and never deploy the new app before the database changes.

## 0. Before the window (30 min)
1. **Precheck (read-only).** Supabase dashboard of the REAL project > SQL editor. Paste `docs/PRODUCTION-PRECHECKS.sql` one block at a time and keep the output.
   - Blocks 2–4: can the public key write money tables (row-level security off on `invoices`, `payment_batches`, `tenants`...)? If any money table is writable by `anon`/`authenticated`, tell Claude before going on: it must be closed before go-live.
   - Block 5–6: expect no rows (none of the new functions or tables exist yet).
   - Block 7: expect `room_logs`, `user_roles`, `late_fee_billed_at`, `notice_date` etc. to exist. If something is missing, stop and ask Claude (a prerequisite migration is needed first; `supabase/migrations/migration-occupancy-proration.sql` creates `room_logs`).
   - Blocks 10–12: lists odd carry-forward rows to look at; they do not block go-live.
2. **Backup.** Supabase > Database > Backups: make sure a fresh backup exists (or download one). Do not continue without it.
3. **Tell Claude the precheck output** (no invoice ids in public places). Claude answers "go" or "fix first".

## 1. In the window: database (30–45 min)
In the SQL editor of the REAL project, run these files one at a time, in this order, from `supabase/migrations/`. Wait for "Success" before the next one. Each file is safe to re-run.
1. `20261002000000_migration-money-events-and-void-payment.sql`
2. `20261002000100_migration-adjustments.sql`
3. `20261002000200_migration-tenant-credits.sql`
4. `20261002000300_migration-refund-payouts.sql`
5. `20261002000400_migration-late-fee-charges.sql`
6. `20261002000500_migration-record-payment-batch.sql`
7. `20261002000600_migration-final-settlement.sql`
8. `20261002000650_migration-refund-and-settlement-correction.sql`
9. `20261002000700_migration-points-redemption.sql`
10. `20261002000800_migration-late-fee-actions.sql`

**NEVER run `20261002000900_migration-test-schema-inferred.sql`** (test database only). Do not run the data-repair files either.
If any file shows an error: STOP. Do not run the next one. Copy the exact error to Claude. Nothing is half-applied inside one file (each file is one transaction).
Optional: put `SET lock_timeout = '5s';` first in each editor tab so a busy table makes it fail fast instead of hanging.

## 2. In the window: deploy the app (10 min)
Deploy the branch the way you normally deploy the app (merge to your production branch, or your platform's deploy). Ask Claude to merge to `main` if that is your route: it has been held back on purpose until you say so.

## 3. Right after (15 min), in this order
1. Open the admin site, invoices page: invoices list loads.
2. Record a real small payment on one test/real invoice; check paid amount, status and the payment history; void it if it was a test (reason required).
3. Credits and refunds page loads without an error.
4. Move-outs page opens; do NOT settle a real tenant just to test.
5. Have one tenant (or you) pay through the LINE payment page and check the invoice (this part could not be tested in a browser).
6. Run `scripts/discrepancy-report.ts` (read-only) and send the output to Claude.

## 4. If something is wrong
- App problem only: redeploy the previous app version. The new database objects are additive and the old app keeps working with them for a short time.
- Database problem: stop, send Claude the error. Do not run rollback notes from the file headers without asking: they delete audit tables.
- Money looks wrong: do not "fix" rows by hand. Send Claude the invoice and what you see.

## What you are accepting (known and written down)
- Findings 161, 163, 164, 168 are open (no money lost): see `docs/money-system-findings.md`.
- The billing report numbers for past months will look lower (carried debt no longer counted twice) and "paid" is split into cash and credit.
- Late fees on a move-out final invoice now appear as lines the admin can void.
- The ChatGPT audit has not been done: you can deploy without it, but then the code has only been checked by Claude's own tests and reviews.
