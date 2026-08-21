# dorm-manager

Next.js + Supabase dorm/apartment management app. Two audiences: an admin web dashboard
(`app/(admin)/*`) and tenant-facing LINE mini-apps (`app/(public)/*`, `app/api/payment-liff/*`,
`app/api/register/*`, `app/api/line/*`). Admin mutations go through `app/api/admin/*/actions`
routes gated by `requireAdminPermission()` (lib/admin-api-auth.ts) against a role/permission
matrix in `lib/permissions.ts`. Tenant-facing routes authenticate via a LINE access token
verified against `tenants.line_user_id`.

## Design system — admin app

Light, floating surfaces. White cards with a hairline edge, lifted off a soft grey-blue canvas
by a shadow rather than boxed in by a border. Apple-adjacent, not an Apple clone.

**Everything visual comes from `components/ui/`. Do not hand-roll a button, input, card, badge,
table or modal in a page.** That is exactly how this codebase drifted before: ~100 inline
buttons in a dozen padding/weight combos, 281 raw `blue-*` against 40 `primary-*`, three
different maps deciding what colour an invoice status is, and seven radius values.

- **Button** (`ui/Button.tsx`) — the only button. Variants `primary | secondary | ghost |
  subtle | danger | success`, sizes `sm | md | lg | icon`. For a `<Link>` styled as a button,
  or an existing `<button>` you don't want to restructure, use `buttonClasses({...})`.
- **Card / SectionCard** (`ui/Card.tsx`) — the floating surface. `interactive` adds the hover
  lift; `raised` starts a step higher.
- **Input / Select / Textarea / Field** (`ui/Input.tsx`) — all share `controlClasses()`, so a
  text field and a dropdown side by side match. Need a bespoke-sized control (e.g. the dense
  meter grid)? Call `controlClasses({ className })`, don't restate the border/focus styles.
- **Badge** (`ui/Badge.tsx`), **Table** (`ui/Table.tsx`), **Modal** (`ui/Modal.tsx`),
  **PageHeader / Tabs / EmptyState / Notice / Skeleton** (`ui/Page.tsx`).

Tokens (tailwind.config.ts):

- **Colour** — `primary` (Apple systemBlue #007AFF) is the one accent. One ramp per meaning:
  `success`, `warning`, `danger`. Never reach for `blue`/`indigo`/`emerald`/`rose`/`amber`/
  `orange` directly; that is the drift this replaced. `apple-*` is reserved for the dashboard
  KPI tints, where each hue carries a documented meaning. `cyan` survives only as the
  water-utility domain tint in the meters table.
- **Radius** — `rounded-control` (12px: buttons, inputs, chips), `rounded-card` (18px: cards,
  panels), `rounded-panel` (24px: modals).
- **Elevation** — `shadow-float` (resting) → `float-md` (hover, sticky headers) → `float-lg`
  (popovers, the sidebar) → `float-xl` (modals). Pick by role, not by taste. Coloured "glow"
  shadows were deliberately removed: they are a different visual language from the neutral
  float scale.
- **Motion** — `ease-float` on every hover/enter transition.

`AdminShell` owns the page title (derived from `components/admin-nav.ts`), so a page should
**not** render its own `<h1>`. `PageHeader` takes an optional description and an actions row;
omit `title` inside the admin shell or you get two titles.

Invoice status colour resolves through `statusVariant` in `lib/invoice-utils.ts`;
`statusPillClass` and `statusRowClass` derive from it. Add a status in one place, not three.

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

**Changing an invoice's status to `paid` must never fabricate a payment.** Both status-change
endpoints (`update_status` in `app/api/admin/invoices/actions/route.ts` and `approve_paid` in
`app/api/admin-liff/invoices/actions/route.ts`) only call `applyInvoicePaymentAllocation` when
`status === "verifying"` **and** `slip_url` is set — i.e. a tenant has actually uploaded a slip
that is now being reviewed and confirmed. Any other case (no slip, or a slip from a much earlier
review that's stale) is rejected; the admin must record the payment explicitly through the
Payments tab, with a real amount and optional slip, instead. Before this guard existed, picking
"paid" from the status dropdown on a partially-paid invoice — with no review step — would treat
the whole remaining balance as cash received and fabricate a batch for it, even copying the
invoice's existing slip image onto the fake batch so it looked backed by evidence. This produced
฿150,000+ of fake payment_batches rows in production before it was caught (cleaned up
2026-08-20; see `payment_batches_backup_20260820` in Supabase). When `getPaymentChainOutstanding`
is already `0` (the invoice was flipped away from paid and back with nothing left owing), neither
endpoint touches the allocation path at all — it just restores `status` and re-freezes the late
fee via `resolveFullyPaidAtDate`.

## Money received — batches, allocations, and frozen accounts

A payment is three rows, not one. `applyInvoicePaymentAllocation` writes:

1. **`payment_batches`** — one row per real money-in event (the transfer the tenant actually
   made), holding the amount received, `paid_at`, slip, source, and the receiving account.
2. **`invoice_payment_allocations`** — one row per invoice that batch was split across.
3. A `payment_history` entry on each affected invoice — a *display cache*, not the record.

Reporting reads 1 and 2. `invoices.paid_amount` is a running balance, not an income figure:
it says how much an invoice has received in total, never *when* the money arrived. A tenant
paying three months of arrears in one transfer moves `paid_amount` on three invoices across
three billing periods while the bank saw one deposit on one day.

The income report has two views over the same allocation data, both filed under the
**invoice's own billing period** (not the calendar month the money happened to arrive in —
invoices here are issued the 25th with a due date early the *following* month, so grouping by
receipt date instead would put most on-time rent one tab away from the period it belongs to).
**Billing** shows one aggregated row per invoice (billed vs. paid). **Cash** shows one row per
individual allocation — the actual amount, `paid_at`, and receiving account for that specific
payment — so a July invoice paid in August still shows under July, with August visible as the
date on the row. Because grouping follows the invoice's period rather than the deposit date, a
given period's cash total is not necessarily what the bank statement shows for that same
calendar month; check the row-level `paid_at` for that. The per-account breakdown is always
cash basis, summed from `invoice_payment_allocations.amount`. A payment counts as *late*
(`ชำระเกินกำหนด`) when its `paid_at` is after that invoice's own `due_date` — never by
comparing calendar months, which routinely flags normal on-time rent under this billing cycle.

**The receiving account is frozen at payment time and never re-resolved.**
`payment_method_snapshot` (a full JSONB copy, on both the batch and every allocation) is the
only valid source when describing a payment that already happened. Do not derive it from
`tenants.custom_payment_method` or from the default `payment_methods` row at read time: both
are mutable, so re-assigning a room's account silently rewrote the attribution of every past
month. `resolvePaymentMethodForTenant` (lib/invoice-ledger.ts) is the *only* place that
resolution happens, called once while recording the payment. Allocations written before this
existed have `payment_method_snapshot = NULL` — report those as unknown; the real account is
unrecoverable and the current tenant column is precisely the wrong answer.

**`invoices.slip_url` belongs to the invoice the slip was submitted against — only.**
`applyInvoicePaymentAllocation` writes it solely for the trigger invoice, and only when a slip
is actually supplied. It used to stamp the trigger's slip onto every invoice in the chain,
which is why settling a chain made older invoices sprout a slip and a `slip_uploaded_at` from
months later — the main reason old invoices looked like they were being rewritten. It also
wrote `slip_url: null` unconditionally, so a later cash payment wiped a slip the tenant had
already uploaded. Per-payment evidence lives on the `payment_history` entry and the allocation
row; `extractAllSlipUrls` is the helper for gathering every slip attached to an invoice.

Idempotency lives on `payment_batches(trigger_invoice_id, idempotency_key)` as a partial
unique index. The older `payment_history` JSON scan is still consulted as a fallback so keys
issued before the table existed keep replaying instead of double-charging.

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
