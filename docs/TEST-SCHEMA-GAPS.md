# Test schema gaps (dorm-test)

Project: `dorm-test` (id `rghxelkifdrpvabyxopb`), a dummy Supabase project. Nothing here touches production.
Date: 2026-10-03.

## 1. What was already in dorm-test

base_schema, payment_batches, money_events_and_void_payment, adjustments, tenant_credits,
late_fee_charges, refund_payouts, record_payment_batch, rewards_points, final_settlement,
late_fee_actions (migration names as recorded in the project, i.e. 20261002000000-500 and
the later settlement and late-fee work). `settings` had one row.

## 2. Applied from repo files (migration `legacy_repo_migrations_catchup`)

All idempotent (`IF NOT EXISTS`), data-repair statements excluded.

| Source file | Result |
|---|---|
| 20260813000000 slip-rejections | `invoices.slip_rejections` |
| 20260704000000 invoice-meter-readings | `invoices.electricity/water_reading_start/end` |
| 20260925000000 meter-reading-previous-source | `meter_readings.previous_source` (+ check) |
| migration-line-meter-staff-status.sql + migration-notify-flags.sql + final-schema.sql | `line_meter_users` table (final-schema definition) with `notify_payment`, `notify_move_out`, status check and indexes |
| migration-move-out-notice-date.sql | `move_out_requests.notice_date` (backfill UPDATE skipped, table empty) |
| migration-room-takeover-requests.sql | `room_takeover_requests`, unique index `idx_tenants_one_active_per_room` |
| migration-tenant-room-transfers.sql | `tenant_room_transfers` |
| migration-occupancy-proration.sql | `room_logs`, view `v_room_reconciliation` |
| 20260820000000 payment-batches-method-snapshot | only the indexes that were missing (`idx_payment_batches_method`, allocation indexes) |
| final-schema / invoice-ledger | missing indexes on carry-forwards and meter_readings |

Already reflected, not re-applied: 20260610 (late-fee columns), 20260629 / 20260814 step 1
(carry-forward unique is already `(source_invoice_id, target_invoice_id)`), 20260730 rewards,
migration-policy-acceptance, migration-tenant-move-out-deposit, migration-tenants-updated-at,
migration-move-out-requests, migration-invoice-ledger, 20261002000000-500.

Skipped on purpose (data repair only): `APPLY-IN-SQL-EDITOR.sql`, the data parts of
20260814 (carry-forward backfill step 2) and 20260820000001 (batch backfill).

## 3. Inferred (not defined by any repo migration)

All marked in SQL as `-- INFERRED from code usage, verify against production`. Recorded in
`supabase/migrations/20261002000900_migration-test-schema-inferred.sql` (NOT FOR PRODUCTION).

- Table `public.user_roles(user_id uuid PK, role text default 'viewer', updated_at timestamptz)`.
  Source: `app/api/admin/user-roles/route.ts` (upsert on `user_id`), `lib/admin-api-auth.ts`. No FK to
  `auth.users` was added; production probably has one. Role value set not constrained.
- Column `invoices.late_fee_billed_at timestamptz`. Source: `app/api/admin/invoices/actions/route.ts`,
  `lib/invoice-generation.ts`.
- Storage buckets `payment_slips` (defined in final-schema.sql, so not really inferred),
  `payment-methods`, `tenant-docs` (public). No storage policies were created (the final-schema
  policies for payment_slips were not reproduced); uploads go through the service role.

## 4. Could not be determined / known mismatches

- RLS and policies: production RLS state is unknown. dorm-test has RLS off on the older tables and on for
  the 2026-10 money tables (as their migrations did). The Supabase advisor flags the off tables.
- `user_roles` real constraints, FK to `auth.users`, RLS, allowed roles.
- Real types for `late_fee_billed_at` (assumed timestamptz because code writes an ISO string).
- Whether production has extra columns, defaults, triggers or indexes the code never touches.
- `meter_readings.billing_month`: `app/api/admin/invoices/actions/route.ts` (about line 979) filters on
  this column, but no migration or table has it (the real column is `reading_month`). Not created.
  Either production has it, or that query is a code bug.
- A scan flagged `invoices.paid_at`; it appears to come from payment_history/allocation objects in the
  same statement, not an invoice column. Not created.
- The column scan is regex-based (select strings, insert/update/upsert top-level keys, filter column
  names). Dynamically built column lists and nested relation selects are not covered.

## 5. Seed data (all fake)

2 buildings (`FAKE Building A/B`), 6 rooms (A101-A103, B201-B203; B203 vacant), 2 payment methods,
5 tenants (`FAKE ...`, `@example.invalid`), 8 invoices covering draft, pending, partial, verifying,
overdue, paid, cancelled; one carry-forward link (overdue A102 Aug into pending A102 Sep, 4,380);
3 payment batches with allocations, of which one (B201 Aug, 3,000) was voided through the real
`void_payment_batch` function (negative reversal allocation, money_events row, invoice back to pending).
Two meter readings. Tenant D (B201) has a move-out date set.
No `payment_history` JSON was written for the seeded payments, so the invoice cards will show
paid amounts without history entries.

## 6. Export production schema and diff against dorm-test

Do this yourself; do not paste production credentials anywhere shared.

1. Production, schema only:
   `supabase link --project-ref <PROD_REF>` then
   `supabase db dump --schema-only --schema public,storage -f prod-schema.sql`
   (or Dashboard > Database > Schema, or `pg_dump --schema-only --no-owner --no-privileges "$PROD_DB_URL" > prod-schema.sql`).
2. dorm-test, same way:
   `supabase link --project-ref rghxelkifdrpvabyxopb` then
   `supabase db dump --schema-only --schema public,storage -f test-schema.sql`.
3. Diff: `diff -u prod-schema.sql test-schema.sql`, or use `supabase db diff --linked` / `migra`
   (`migra "$PROD_DB_URL" "$TEST_DB_URL"`) which prints the SQL needed to turn production into test.
4. Review: every object under section 3 and 4 above. Anything in prod but not in test is a gap to add to
   dorm-test; anything in test but not in prod (e.g. `late_fee_billed_at`) means the code needs a
   production migration. Also compare RLS (`pg_policies`), triggers and functions.
5. Optionally dump the data-free function list: `select proname from pg_proc where pronamespace='public'::regnamespace`
   on both sides.
