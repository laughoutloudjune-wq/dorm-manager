# dorm-manager

Next.js + Supabase dorm/apartment management app. Two audiences: an admin web dashboard
(`app/(admin)/*`) and tenant-facing LINE mini-apps (`app/(public)/*`, `app/api/payment-liff/*`,
`app/api/register/*`, `app/api/line/*`). Admin mutations go through `app/api/admin/*/actions`
routes gated by `requireAdminPermission()` (lib/admin-api-auth.ts) against a role/permission
matrix in `lib/permissions.ts`. Tenant-facing routes authenticate via a LINE access token
verified against `tenants.line_user_id`.

## Invoice lifecycle

Statuses: `draft` → `pending`/`overdue`/`partial` → `paid`, or `cancelled` at any point before
paid. `verifying` means a payment slip was uploaded and is awaiting admin confirmation —
`syncInvoiceLedger` (lib/invoice-ledger.ts) will not auto-change status out of `verifying`.

Late fees: the **current** month's invoice never dynamically accrues a late fee. Late fees are
calculated once, at the point an invoice is fully paid or carried forward, and locked into
`locked_late_fee_amount`. They show up as a line item on the **next** invoice, not as a running
total on the invoice they originated from. See the comments in `syncInvoiceLedger` and
`calculateLateFeeAmount`.

Carry-forward: an unpaid invoice can be linked to a newer invoice via `invoice_carry_forwards`
(source → target). `getCarryForwardCandidatesForTarget` computes what's eligible; a source
invoice's own `total_amount`/`paid_amount` is authoritative for whether it's still outstanding,
regardless of whether it's linked to a carry-forward target.

Payments: always go through `applyInvoicePaymentAllocation` (lib/invoice-ledger.ts), never a
raw `paid_amount` update. It resolves the full carry-forward chain for the target invoice,
allocates the payment oldest-first, and supports an idempotency key so a retried request replays
the original result instead of double-charging.

## Rent proration — one canonical rule

**Daily rate = `dailyRentRate(monthlyRent)` = `Math.floor(monthlyRent / 30)`** — a fixed 30-day
cycle, rounded DOWN to a whole baht, defined once in `lib/invoice-utils.ts`. Every proration
calculation (move-in, room transfer, move-out) must use this helper for the daily rate. This
used to be reimplemented three-to-five times across the codebase with inconsistent rounding
(some divided unrounded, one used `Math.round` on the final product) — those all produced
different bills for what should've been the same math. If you're adding a new proration path,
import `dailyRentRate` rather than writing `rate / 30` again.

## Move-out flow

Two decoupled steps, not one:

1. **Vacate** (`move_out` action in `app/api/admin/tenants/actions/route.ts`, exposed as
   "ปลดล็อกห้องทันที" in the move-out UI): marks the tenant inactive and frees the room
   immediately. No settlement math, no invoice. `room_id` is deliberately left set on the
   tenant row — that's how the "pending settlement" list on the move-outs page finds tenants
   who were vacated but not yet settled (`status='inactive' AND room_id IS NOT NULL`).
2. **Settle** (`final_move_out` action): computes prorated rent, utilities, deposit
   forfeiture, and creates the final invoice, then clears `room_id`. Can run any time after
   step 1, independently of room occupancy — it takes `roomId` explicitly in the request body
   rather than reading it off the tenant row, precisely because step 1 may have already
   started clearing tenant state.

The self-service room "takeover" flow (a stranger claiming an occupied room via LINE
registration) is only permitted when the current active tenant already has a `move_out_date`
set — enforced server-side in `app/api/register/route.ts` and `app/api/register/takeover/route.ts`.
Without that check anyone could claim any occupied room by guessing its room number.

## Meter readings — single source of truth, two writers only

`meter_readings` (room_id + reading_month → previous/current electricity & water) is written
ONLY by `app/api/admin/meters/actions/route.ts` (Meters page save button) and
`app/api/admin-liff/meters/actions/route.ts` (LINE meter-staff LIFF). Every other file that
touches this table — move-out settlement, reports, receipts, dashboard stats — must only
`select` from it, never insert/update/upsert. This can't be enforced with Postgres RLS here:
every server route uses the service-role key, which bypasses RLS uniformly, so the DB can't
tell "the Meters page" apart from any other route. The only real enforcement is code review —
if you're adding a write to `meter_readings` anywhere other than those two files, stop and
reconsider.

Anything that needs a tenant's/room's last known reading (e.g. move-out settlement computing
usage as current − previous) must read the latest `meter_readings` row for that room, not
reconstruct it from invoice history or a tenant's original move-in reading. A past bug in
`MoveOutProcessingModal.tsx` did exactly that: the on-screen "previous reading" was correctly
sourced from `meter_readings`, but the value actually submitted to `final_move_out` was
separately (and wrongly) derived from `invoiceHistory[0].electricity_reading_end` — a field
regular monthly invoices never populate — falling through to the tenant's original move-in
reading. For a long-tenured tenant this produced a massively inflated "usage" on their final
bill. Both values must come from the same place.

## Known intentional duplication

`resolveElectricityUsage`/`resolveWaterUsage` exist in both `lib/invoice-utils.ts` and
`app/api/receipt/[token]/route.ts`. They look like accidental copies but aren't quite identical
on purpose: the receipt route's version returns `null` for missing data (rendered as `-` on the
printed receipt), while the shared version returns `0` (needed for sums elsewhere). Don't merge
these without auditing every caller's null-handling first.

## Testing

`npx vitest run` — proration and invoice-ledger math have test coverage in `lib/*.test.ts`.
There is no test coverage for the API routes themselves; changes there should be verified
manually against the actual admin UI / LIFF flows.
