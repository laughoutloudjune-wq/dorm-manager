# Dorm-manager — full system audit & improvement plan (detailed)

**Date:** 2026-09-29
**Scope:** whole repository (Next.js app, API routes, LINE mini-apps, `lib/` money engine) **plus a read-only check of the live Supabase database** (project `ApartmentFlow`, `hunofnfolufasvsmcwby`).
**Nothing was changed.** No code was edited and no data was written. All database work was `SELECT` only.
**Tests:** `npx vitest run` → 4 files, 101 tests, all passing.

The companion file `2026-09-29-system-audit-plain-english.md` explains the same thing without technical words.

---

## 0. How to read this

Every finding has:

- **Where**: file and line.
- **What happens**: the real-world effect.
- **Evidence**: what the code does, and (where possible) what the live data shows.
- **Fix**: the recommended direction. Nothing here is implemented yet.

Severity:

| Level | Meaning |
|---|---|
| 🔴 Critical | Anyone on the internet could read or change data, or a person could take over an account. Fix first. |
| 🟠 High | Money can be recorded wrongly, lost from reports, or a workflow breaks. |
| 🟡 Medium | Wrong numbers on screen/reports, confusing behaviour, missing guard rails. |
| ⚪ Low | Maintenance / code health. |

### Snapshot of the live data (29 Sep 2026)

| Item | Count |
|---|---|
| Rooms | 80 |
| Tenants (active) | 98 (79) |
| Invoices | 587 |
| Payment batches / allocations | 478 / 485 |
| Payment batches by source | admin web 406 · LINE approve 69 · abandon room 2 · old "status paid" 1 |
| Carry-forward links | 22 (5 created **after** the "invoices are independent" change on 31 Aug) |
| Admin logins (auth users) | 4 (roles: 1 owner, 1 viewer, 2 with no role row → treated as viewer) |
| Active meter staff | 2 |

### Already known and deliberately left alone (not re-flagged)

Per the earlier decision recorded on 2026-08-28, these rooms' historical `paid_amount` vs allocation differences are **known, real arrears, and intentionally not corrected**: **114/1, 116/1, 201/2, 109/1, 206/1, 207/2**. They appear in the data checks below but are not new findings. See section 6 for the few *other* rows that showed up.

---

## 1. 🔴 Critical — security and account takeover

### C1. The whole database is open to the public internet

- **Where:** Supabase database settings (all tables in `public`).
- **Evidence (live DB):** Row-Level Security is **OFF on all 26 tables** (only `room_takeover_requests` has it on, with zero policies). The `anon` role has `SELECT, INSERT, UPDATE, DELETE, TRUNCATE` on `invoices`, `tenants`, `payment_batches`, `settings`, `meter_readings`, **`user_roles`**, and the backup tables.
- The `anon` key is, by design, shipped inside every web page (`NEXT_PUBLIC_SUPABASE_ANON_KEY`).
- **What happens:** anyone who opens any page of the site can copy that key and, with a few lines of code:
  - read every tenant's name, phone, LINE ID, deposit, bank details and every invoice;
  - change any invoice's amount, `paid_amount`, or status; insert fake payments; delete or truncate tables;
  - write rows into `user_roles` (the permission table);
  - read the backup tables (`invoices_money_backup_20260820`, `payment_batches_backup_20260820`, `realloc_backup_*`).
- **Why it is this way:** several screens talk to the database directly from the browser instead of through the API, so RLS was never switched on:
  - Tenant payment page writes the invoice itself — `app/(public)/payment/[token]/page.tsx:555` (sets `slip_url`, `status: "verifying"` directly, bypassing the checks in `/api/payment-liff/submit`).
  - Public room search reads invoices with the anon key — `app/(public)/payment/search/page.tsx:30`.
  - The admin invoice screen writes invoices from the browser — `lib/hooks/use-invoices-state.ts:292`, `:309`, `:430`, and **all monthly invoice generation** at `:3720` / `:3749`.
- **Fix:**
  1. Move every browser-side write into an API route (these 6 places).
  2. Turn on RLS on every table with **deny-all** for `anon`; allow `authenticated` only what the admin screens need to *read* (or move reads to API routes too).
  3. Revoke `anon` grants on tables. Server routes already use the service-role key, so they keep working.
  4. Move the backup tables into a private schema (or drop them after exporting).

### C2. File storage is open: anyone can list and upload files in every bucket

- **Where:** Supabase Storage policies.
- **Evidence (live DB):** policies `slips upload 1t7jg3_0` (SELECT, `true`) and `slips upload 1t7jg3_1` (INSERT, `true`) apply to **all buckets**, and `contracts` has the same. All four buckets (`payment_slips`, `tenant-docs`, `contracts`, `payment-methods`) are public.
- **What happens:** anyone can list every file in `tenant-docs` and `contracts` (deposit slips, contracts, possibly ID documents) and download them, and can upload arbitrary files (including fake "slips") into any bucket.
- **Fix:** make `tenant-docs` and `contracts` private and serve them through short-lived signed URLs; restrict uploads to paths the server hands out; delete the catch-all `true` policies.

### C3. Anyone can make themselves "meter staff" and change meter readings (which set the bills)

- **Where:** `app/api/meter-staff/register/route.ts:40` sets `status: "active"` for whoever calls it. `app/api/line/webhook-meter/route.ts` upserts every LINE user who messages the meter bot, and the table default is `status = 'active'` (`supabase/migrations/migration-line-meter-staff-status.sql`).
- **What happens:** any LINE user who opens the staff-register link, or just messages the meter bot, becomes an active meter recorder and can overwrite any room's readings through `/api/admin-liff/meters/actions` — which directly changes electricity/water bills. Re-registering also re-activates someone an admin had switched off.
- **Fix:** new sign-ups start as `pending`; only an admin can switch them to `active`; the webhook must never create active users; change the column default to `pending`.

### C4. LINE registration can take over another tenant and wipes their deposit / move-in date

- **Where:** `app/api/register/route.ts:204-217` (update path) and `:230-240` (insert path).
- **What happens:**
  1. In **"existing tenant"** mode there is no ownership check. If a room's active tenant has no LINE linked yet, whoever types that room number gets linked to that tenant record and can then see their bills.
  2. The update always writes `security_deposit_amount` and `advance_rent_amount` from the request — but the registration page never sends them (`app/register/page.tsx:291-310`), so they become **0**. It also writes `move_in_date` = `null` for existing-tenant mode and wipes the deposit slip links.
- **Evidence (live DB):** **47 of 79 active tenants have deposit = 0 and advance rent = 0** (36 of those registered via LINE and accepted the policy). **9 active tenants have no move-in date.** A move-in date is needed for proration and rewards milestones; the deposit is what the move-out settlement refunds.
- **Fix:** registration may only set `line_user_id` (and maybe phone/name). Never touch money fields or dates from this endpoint. Linking an existing tenant needs a second factor (e.g. phone number already on file must match, or admin approval).

---

## 2. 🟠 High — money correctness

### H1. Debts are still being "carried forward" into new bills, so the same debt shows up 2–3 times

- **Where:** invoice editor checkbox `toggleCarryOverFromCandidate` (`lib/hooks/use-invoices-state.ts:2200`) → `save_details` re-creates `invoice_carry_forwards` links (`app/api/admin/invoices/actions/route.ts:175-210`).
- **Background:** on 31 Aug (commit `0e1e825`) invoices were made independent — monthly generation no longer merges an old unpaid bill into the new one. But the **manual** "pull arrears from last month" box still merges them.
- **Evidence (live DB):** 5 carry links created after 1 Aug. Examples (open balance / carried-in amount):
  - 109/1 — July 2,867 · Aug 5,758 (includes July's 2,867) · Sep 8,666 (includes Aug's 5,758). Real debt ≈ **8,666**, but adding the three rows gives **17,291**.
  - 114/1 chain Apr→Jul, 115/1 Aug→Sep, 116/1 Jun→Aug, 212/2 Jul — same pattern.
  - Raw sum of all open balances = **334,583 baht**, which counts these debts more than once.
- **Where the double count leaks out:**
  - "Split payment" picker shows each invoice's *bundled* balance — `use-invoices-state.ts:1134` — so an admin can allocate the same debt twice.
  - Tenant LINE app lists every open invoice with its bundled total (`/api/payment-liff/invoices`).
  - Auto-allocation `applyInvoicePaymentAllocation` pays the source first, then the target — whose total still contains the source's debt — so the target stays "partial" for money that was already paid (the 212/2 7,594 case in CLAUDE.md). The manual split path refreshes targets (`refreshCarryForwardTargets`) but the normal payment path does not (`lib/invoice-ledger.ts:1928`).
- **Fix (needs your decision, Q1):** pick one model. Recommended: **invoices stay independent**; remove the principal carry-over checkbox (keep only the late-fee line), show "older unpaid bills" as a separate list on the tenant's bill and on the admin screen, and have one "tenant balance" number = sum of each invoice's own outstanding.

### H2. Two different "undo a payment" buttons, and one of them breaks the ledger

- **Where:**
  - "ยกเลิกรายการ" on each payment row → `cancelPaymentEntry` (`use-invoices-state.ts:1304`) → `record_payment` with a raw `payload` (`route.ts:279`), which writes `paid_amount`, `status`, `payment_history` directly.
  - "Delete payment" → `delete_payment_batch` (`route.ts:321`), which deletes the batch and allocation rows but **does not** fix `paid_amount`/status.
- **What happens:**
  - Button 1 lowers `paid_amount` but leaves the `payment_batches` + `invoice_payment_allocations` rows, so **the income report keeps counting money that was cancelled**. It also sets status to `pending` even if the bill is overdue.
  - Button 2 removes the money from reports but the invoice still says it's paid.
  - Both are hard deletes with no record of who did it or why.
- The raw `payload` path of `record_payment` lets anyone with "record payment" permission write *any* invoice column (including `total_amount`).
- **Fix:** one action, **"Void payment"**: marks the batch voided (with reason + who + when, never hard-deleted), removes its allocations from totals, recalculates `paid_amount` and status from what's left. Remove the raw `payload` path.

### H3. "Paid" is just a label, and it can disagree with the money

- **Where:** `update_status` (`app/api/admin/invoices/actions/route.ts:43`), LINE admin `update_status` and `edit_invoice` (`app/api/admin-liff/invoices/actions/route.ts:55`, `:189`), status dropdowns in `InvoiceDetailModal.tsx:533` and `InvoicesPageView.tsx:424`.
- **What happens:** picking "ชำระแล้ว" without recording money:
  - makes the receipt PDF available (`/api/receipt/[token]` only checks `status === "paid"`) — a real-looking receipt for money never received;
  - awards on-time rewards points (points are based on status);
  - hides the invoice from outstanding totals on the dashboard;
  - is ignored by the nightly-style status sync for `paid` rows, so it stays that way.
- The LINE-admin version skips the late-fee freeze/unfreeze logic the web version has.
- **Evidence (live DB):** 4 invoices are "paid" but short by **11,143 baht** in total (109/1 Apr, 201/2 Mar, 206/1 Mar, 212/2 Mar — the known cases).
- **Fix:** status becomes *calculated* from money (pending / partial / paid / overdue). Keep only these manual states: `draft`, `cancelled`, and a new explicit **"closed without full payment"** (write-off) that requires a reason and is shown differently everywhere. Receipts only when money covers the bill. (Q2)

### H4. Approving a slip in the LINE admin app records the full balance, not what the slip shows

- **Where:** `app/api/admin-liff/invoices/actions/route.ts:154` — `amount: Number.MAX_SAFE_INTEGER`.
- **What happens:** if a tenant transfers 2,000 of a 3,000 bill and an admin taps "approve", the system records **3,000 received**. Tenants never type an amount when uploading a slip, so there is nothing to compare against. If a tenant uses one slip for several months (the LINE app allows selecting several invoices), each approval creates its own batch with the same slip.
- **Evidence:** 69 payments were created this way.
- **Fix:** tenant enters the amount with the slip; approver sees slip + amount and confirms or corrects before saving. Later, add automatic slip checking (section 7). (Q7)

### H5. Move-out refunds are not tracked — they are auto-marked "paid" and disappear

- **Where:** `final_move_out` in `app/api/admin/tenants/actions/route.ts:439-611`.
- **What happens:**
  - Deposit + advance rent are subtracted as a "discount" (`:555-557`). When they are larger than the final charges the invoice total goes **negative** (money owed back to the tenant).
  - The status sync sees "nothing owed" and flips it to **paid**. There is no record of whether the refund was actually handed back, when, or from which account.
  - Older unpaid invoices are **not** deducted from the deposit (only "abandon room" does that), so a tenant can get a full refund while still owing earlier months.
  - The final bill ignores the water minimum and the common fee (`:528-529`, `commonFee: 0`), unlike monthly bills.
  - Not protected against double-click (two final invoices possible).
- **Evidence (live DB):** 6 final invoices with negative totals, all "paid": 101/1 (−2,585), 112/1 (−5,830), 202/1 (−3,260), 204/1 (−5,900), 213/2 (−2,407), 216/2 (−3,288) → **23,270 baht of refunds with no payout record**. 216/2 also still has an **overdue July invoice (3,790)** that the deposit did not cover.
- **Fix:** a proper **settlement statement**: all open debts + final charges − deposit/advance = amount to collect **or** amount to refund. A refund is recorded as money *out* (date, account, who). (Q4, Q11)

### H6. "Abandon room" (ทิ้งห้อง) is broken since 22 Aug

- **Where:** `app/api/admin/tenants/actions/route.ts:842-855` sets `status: "abandoned"`.
- **Evidence (live DB):** the `invoice_status` type is `draft, pending, verifying, paid, overdue, cancelled, partial` — **no `abandoned`**.
- **What happens:** the credit is applied to the first invoice, then the status update fails, the request returns an error, and the tenant is left **active** with the room still assigned — half-done. The status dropdown also offers "ทิ้งห้อง", which will error. Also `syncInvoiceLedger` (`lib/invoice-ledger.ts:648`) does not skip that status, so even if it existed it would be overwritten on the next page load.
- The "credit left to refund" is only shown in a toast, never saved.
- **Fix:** decide whether "abandoned" is a status or just a payment source (it is already recorded as source `abandon_room`). Simplest: drop the status, rely on the source label. Save the refundable credit.

### H7. Deleting a room or a tenant deletes all of their bills and payments

- **Where:** foreign keys `invoices.tenant_id … ON DELETE CASCADE`, `invoices.room_id … ON DELETE CASCADE`, `invoice_payment_allocations.invoice_id … ON DELETE CASCADE` (`supabase/migrations/final-schema.sql`). Delete actions: `delete_tenant` (`tenants/actions/route.ts:293`, needs only "edit tenant") and `delete_room` (`settings/actions/route.ts:121`).
- **What happens:** one click removes the tenant's whole invoice and payment history; income reports for past months change. `payment_batches` rows are left orphaned.
- **Fix:** block deletion when any invoice/payment exists; offer "archive" instead. Change the foreign keys to `RESTRICT`.

### H8. Invoices that already hold money can be deleted

- **Where:** `delete_many` (`app/api/admin/invoices/actions/route.ts:471-497`).
- **What happens:** drafts are always deletable, even with money on them; a partial invoice paid in cash (no slip) is deletable. Deleting removes its allocations but not the batch.
- **Evidence (live DB):** 3 drafts hold money: 119/2 Jul (3,235), 212/2 Apr (4,490), 212/2 May (7,594).
- **Fix:** refuse deletion if any allocation exists; use "cancel" instead.

### H9. Room transfer sets the wrong room status

- **Where:** `save_tenant` (`app/api/admin/tenants/actions/route.ts:229-240`) called by the transfer wizard with `payload: { id, room_id }` (`components/admin/MoveRoomWizardModal.tsx:204`).
- **What happens:** because the payload has no `status`, the code marks the **new** room `available` and never frees the **old** room (it stays `occupied`). Monthly generation only bills `occupied` rooms, so the tenant can be **skipped** and the old room gets a "no tenant" warning. The old room's history is closed with the tenant's *original* move-in date instead of the transfer date (`:136`).
- **Evidence:** 7 transfers so far; room statuses look consistent today, so they were most likely corrected by hand. Please confirm (Q13).
- **Fix:** transfer = one server action that frees the old room, occupies the new one, closes/open logs on the transfer date.

### H10. No database transactions; two people acting at once can lose money records

- **Where:** `applyInvoicePaymentAllocation` / `applyManualInvoicePaymentAllocation` (`lib/invoice-ledger.ts:1599`, `:1999`), invoice generation (`use-invoices-state.ts:3073`, runs in the browser).
- **What happens:**
  - A payment is ~5 separate writes. `paid_amount` is read, added to, and written back. If the web admin and the LINE admin record a payment on the same invoice at the same moment, one can overwrite the other.
  - On an error, the "undo" writes back a snapshot taken *before* — which can wipe a payment someone else saved in between (`:1905-1924`).
  - Idempotency is "check, then insert" — two identical clicks can both pass the check.
  - Generation: two admins (or two tabs) clicking "Generate" can create duplicate invoices for a room/month; there is **no unique index** on (room, period). If the browser closes mid-run, late fees may be billed but not marked billed (the code warns about this).
- **Fix:** move payment recording and generation into Postgres functions (RPC) that run in one transaction with row locks; add a unique index on `(tenant_id, start_date, end_date)` for normal monthly invoices.

### H11. Late fees: some are never billed, and the amount stops growing for people who never pay

- **Where:** `generateInvoices` late-fee relay (`use-invoices-state.ts:3575-3604`), `autoBillUnbilledLateFees` (`lib/invoice-ledger.ts:1002`), `computeLateFeeSnapshot` (`:376`).
- **What happens:**
  - A late fee is billed only onto the tenant's **next** invoice. Tenants who leave (or abandon) have no next invoice, so the fee is never charged.
  - The fee is frozen the first time a new bill is generated (~15 days × 100 = 1,500) and then **never grows**, even if the old bill stays unpaid for months — while someone who pays 14 days late pays 1,400. Behaviour is inconsistent with "100 baht per day".
- **Evidence (live DB):** frozen but never billed: 112/1 Jun 1,500 · 212/2 Mar 5,000 · 212/2 Jun 1,500 = **8,000 baht**. 109/1 July is 50 days late, still unpaid, fee frozen at 1,500. 114/1 Apr–Jul, 212/2 Jul and 216/2 Jul (departed/previous tenants) have no fee billed at all.
- **Fix:** decide the rule (Q3). Then compute fees in one place, daily, with a cap if you want one, and include unbilled fees in the move-out settlement.

### H12. Permission bypass through "save settings"

- **Where:** `save_general`, `save_utilities`, `save_invoice_config` (`app/api/admin/settings/actions/route.ts:9-31`) write whatever object the browser sends into the `settings` row.
- **What happens:** a user allowed to edit only "general settings" can send `role_permissions` (the permission matrix) or `rewards_config` and change them. The default "admin" role has general settings but *not* permissions — so an admin can promote themselves.
- Similar "pass-through" writes: `save_tenant` and `move_out` spread the request body into the tenant row; `add_room`/`save_rooms` into rooms.
- **Fix:** every settings action whitelists its own fields.

---

## 3. 🟡 Medium — wrong numbers, confusing behaviour, missing guards

| # | Finding | Where | Effect | Fix |
|---|---|---|---|---|
| M1 | Just **opening** the invoice list writes to the database (pending→overdue, slip→verifying, re-applies discount rules and rewrites totals) — for every user, including viewers | `use-invoices-state.ts:285-437, 447-458` | Totals of bills already sent to tenants can change silently when a discount rule changes; changes depend on who opens which month | Move to a scheduled server job; never rewrite a sent bill without a log |
| M2 | Invoices of tenants who gave notice are **hidden** from the invoice list | `use-invoices-state.ts:553-554` | Money owed by people about to leave is easy to miss | Show them with a "moving out" badge |
| M3 | Meter readings: no check that current ≥ previous or for unusual jumps; changing a reading after the bill exists does **not** update the bill, but the discount rules re-run with the new reading | `app/api/admin/meters/actions/route.ts`, `admin-liff/meters/actions/route.ts`, `use-invoices-state.ts:363-417` | Wrong bills, bill and discount disagree | Validation + "reading changed after billing" warning + one-click rebill |
| M4 | Web meter save and LINE meter save write different column sets (LINE also writes legacy `usage/previous_reading`) | same files | Readers fall back between old/new columns | One writer function |
| M5 | Cash report puts deposit credits (abandon room) inside "received" and per-account totals | `components/admin/ReportsPageView.tsx:365, 559-579` | Cash total bigger than the bank statement | Show non-cash in a separate line |
| M6 | Utility report uses **today's** rates × units, ignores the water minimum, and only counts "paid" invoices | `ReportsPageView.tsx:855-881` | Doesn't match what was billed | Use billed amounts from invoices |
| M7 | Dashboard "collected" = invoices whose *status* is paid; reports use real payments | `app/api/admin/dashboard-stats/route.ts:206` | Dashboard and reports disagree | Use allocations everywhere |
| M8 | 11 early-2026 invoices have `paid_amount` but no payment record (paid before the ledger existed): 109/2, 112/1, 113/1, 115/2, 201/1, 210/1, 210/2, 211/1, 211/2, 212/1, 214/1 | live data | Missing from the cash report | Already solvable with the existing "assign account" backfill button — list only, your call |
| M9 | Reports/dashboards load whole years with no paging; the database returns at most 1,000 rows per request | `ReportsPageView.tsx:191-241` | 80 rooms × 12 = 960 invoices/year — will silently cut off next year | Server-side report queries / pagination |
| M10 | "Today" is computed in UTC in ~38 places (`toISOString().slice(0,10)`) | e.g. `lib/invoice-ledger.ts:663`, `slip-review.ts`, move-out code | Between 00:00 and 07:00 Bangkok time the system thinks it's yesterday (overdue flips, default payment dates) | One `todayBangkok()` helper |
| M11 | Admin print-out shows the discount twice and inserts tenant name / notes into HTML unescaped | `use-invoices-state.ts:2918, 3027-3035, 3046` | Confusing printout; a tenant can put code in their LINE-registered name that runs in the admin's browser | Escape (helper `escapeHtml` already exists in `lib/format.ts`), remove duplicate row |
| M12 | "Delete slip" permanently deletes all slip files for the invoice and scrubs them from payment history | `use-invoices-state.ts:1389-1444` | Payment evidence destroyed | Keep files; mark as "removed" |
| M13 | Recording a cash payment re-uses the invoice's existing slip image if none is attached | `use-invoices-state.ts:991` | A new payment looks evidenced by an old slip (the pattern CLAUDE.md warns about) | Only attach a slip the admin actually selects |
| M14 | LINE admin app has **full power** (any LINE ID in `LINE_ADMIN_USER_IDS`), no role matrix; LINE tokens checked only via "get profile", not that they belong to your LINE channel | `lib/line-admin-auth.ts` | Can't give staff limited LINE access; tokens from other LINE apps accepted | Verify token's channel; map LINE admins to roles |
| M15 | Tenant can pick several invoices + one slip; each approval becomes a separate payment with the same slip; tenant never enters an amount | `app/api/payment-liff/submit/route.ts` | One bank transfer recorded as several | One slip = one batch split across invoices |
| M16 | Move-out request: no server check of date in the past / 30-day notice; tenants who already left can still file | `app/api/payment-liff/move-out/route.ts` | Inconsistent notice handling; deposit forfeiture is fully manual | Server validation; flag short notice automatically |
| M17 | 18 draft invoices, 12 from past months. Drafts never become overdue and tenants can't see them | live data | Bills that were never sent | Auto-send or daily "unsent drafts" alert |
| M18 | Default bank account = oldest `payment_methods` row; `is_active` ignored | `lib/invoice-ledger.ts:526-533`, tenant page, print | Deleting/reordering an account silently changes where tenants are told to pay | Explicit "default account" setting |
| M19 | Rewards: revoking points deletes the award rows even if the tenant already spent them; expiry applies to earned but not spent points; redemption has a check-then-write race | `lib/points-ledger.ts:527-547, 598-612` | Balances can go negative (none today) | Ledger-style reversal entries |
| M20 | Takeover approval makes the old tenant inactive but doesn't close their move-out request; move-out date defaults to today instead of the date on record | `app/api/admin/takeovers/actions/route.ts` | Loose ends in move-out list | Reuse the vacate action |
| M21 | "Vacated but not settled" tenants keep getting a **full month** invoice every cycle | `use-invoices-state.ts:3128-3225` | A person who left may be billed rent for a month they didn't live there | Your decision (Q6) |

---

## 4. ⚪ Low — maintenance and code health

| # | Finding | Where |
|---|---|---|
| L1 | Migrations folder doesn't describe the real database: `user_roles`, `late_fee_billed_at`, several columns and the RLS/storage state aren't in it. `final-schema.sql` is a **"drop everything and recreate"** script — dangerous if someone runs it | `supabase/migrations/` |
| L2 | Dead code: `components/admin/SettingsView.tsx` (not used anywhere; writes and deletes rooms straight from the browser), `reallocatePaymentsForInvoice` (never called), `invoice_arrears_snapshots` fallback paths | — |
| L3 | "One engine" rule not fully followed: generation adds up the total by hand (`use-invoices-state.ts:3611-3618`); move-out proration exists twice (modal + route); default billing day is 25 in move-out code but 1 in generation | — |
| L4 | Some comments are wrong: `updateFeeItem`/`updateDiscountItem`/`recalculateCurrentInvoiceArrears` say the late fee passed is "own + carried", but it is own only; the on-screen total is corrected a moment later by a `useEffect` (`use-invoices-state.ts:4039-4072`). Works today by luck | — |
| L5 | No tests for API routes or the invoice screen logic; the 101 unit tests cover the pure math only | — |
| L6 | `send-invoice` uses the "record payment" permission, and can push a message to any LINE user id if no invoice id is given | `app/api/send-invoice/route.ts` |
| L7 | 4,288-line hook `use-invoices-state.ts` holds UI state, business rules, generation and printing together | — |

---

## 5. Workflow map (as it works today)

```
Meter readings ──► Generate invoices (browser, manual click, as DRAFT)
   (web or LINE staff)        │
                              ▼
                    Admin edits / sends each to LINE (→ pending)
                              │
      Tenant uploads slip ────┤  (tenant page writes DB directly)
                              ▼
                     verifying ──► Admin approves (LINE: records FULL balance)
                              │     or records payment on web (types amount)
                              ▼
     Status sync on page load (overdue/partial/paid) — runs when someone opens the list
                              │
Late fee: frozen & put on NEXT month's bill at generation (or on payment)
                              │
Move-out: request (LINE) → approve → vacate (free room) → settle (final bill, deposit as discount)
```

Main structural weaknesses: things happen **when someone opens a page** instead of on a schedule; the browser does work the server should do; money and status are two separate truths.

---

## 6. Data found during this audit (list only — nothing corrected)

Following the "prevent first, ask before touching old money" rule, these are **for your decision only**:

| Item | Rows | Amount |
|---|---|---|
| Final move-out bills with negative total, auto-"paid", no refund record | 101/1, 112/1, 202/1, 204/1, 213/2, 216/2 | 23,270 owed back (was it paid?) |
| Late fees frozen but never billed | 112/1 Jun, 212/2 Mar, 212/2 Jun | 8,000 |
| Draft invoices holding money | 119/2 Jul, 212/2 Apr, 212/2 May | 15,319 |
| `paid_amount` ≠ recorded allocations, **not** in the known list | 106/1 Mar (paid 4,763 / allocated 11,050), 110/2 Jul (6,836 / 4,154), 212/2 Mar & May | — |
| Paid before the ledger existed (no allocation row) | 11 invoices Jan–Mar 2026 (M8) | — |
| Active tenants with deposit = 0 and advance = 0 | 47 | — |
| Active tenants with no move-in date | 9 | — |
| Old drafts never sent | 12 | — |

---

## 7. Improvement plan

Principle: **automate the routine, keep a human on anything that moves money or is unusual.** Every automatic step gets (a) an on/off switch in Settings, (b) a preview or "hold" option, (c) an entry in an audit log.

### Phase 0 — Lock the doors (1–3 days) — do first

1. Move the 6 browser-side writes into API routes (C1).
2. Enable RLS deny-by-default on all tables, revoke `anon` grants, move backup tables out of `public` (C1).
3. Make `tenant-docs`/`contracts` private; delete catch-all storage policies (C2).
4. Meter staff: pending until approved; webhook never activates (C3).
5. Registration: only links LINE ID; never writes money/dates; existing-tenant link needs phone match or admin approval (C4).
6. Settings/tenant actions whitelist fields (H12).
7. Check in Supabase Auth that public sign-up is **disabled** (couldn't verify by SQL).

### Phase 1 — One truth for money (1–2 weeks)

1. Decide the carry-forward model (Q1) and remove the other one from the UI (H1).
2. Status derived from money; add "closed without full payment" with reason (H3).
3. One "Void payment" action with reason; remove raw-payload writes (H2).
4. LINE approve requires a confirmed amount; tenant enters amount with slip (H4, M15).
5. Move payment recording + invoice generation into database functions with transactions; unique index per tenant/period (H10).
6. Block deleting rooms/tenants/invoices with history; switch to archive (H7, H8).
7. Fix abandon-room status (H6) and room transfer (H9).
8. **Audit log table** (`money_events`): who, when, what changed, before/after, reason — written by every money/status action.
9. Tests for each API route that touches money (at least: record, split, void, approve, settle).

### Phase 2 — Move-out & late-fee rules (1 week, after your answers)

1. Settlement statement: open debts + final charges + unbilled late fees − deposit/advance = collect or refund; refunds recorded as money out (H5).
2. Late-fee rule as decided (daily growth? cap? charged at move-out?) (H11).
3. Deposit/advance captured properly at move-in (C4 follow-up).

### Phase 3 — Automation with control (2–3 weeks)

| Automation | Runs | Human control |
|---|---|---|
| **Daily status job** (overdue, reminders due) | Every morning (Vercel Cron or Supabase `pg_cron`) | On/off; nothing about money changes |
| **LINE reminders** to tenants: 3 days before due, on due date, 1/7 days after | Daily | Per-tenant "don't remind"; message templates in Settings |
| **Meter completeness + anomaly check** (missing rooms, current < previous, usage > 2× average) | When meters are saved and on the 24th | Staff must confirm flagged readings |
| **Auto-draft invoices** on billing day once all meters are in | Monthly (25th) | Admin reviews a "ready to send" screen; one click sends all; or auto-send after N hours unless put on hold |
| **Slip check**: tenant enters amount; optional bank-slip verification service reads amount/date/receiver account | On upload | Auto-approve only when slip is verified **and** amount matches exactly (switchable); everything else → review queue |
| **Late-fee accrual** per the agreed rule | Daily | Waive button with reason |
| **Move-out**: approved request → settlement draft created on the move-out date; reminder to read meters | On date | Admin confirms settlement and refund |
| **Nightly reconciliation**: paid vs allocations, status vs money, room vs tenant, unbilled fees, drafts not sent, refunds not paid | Nightly | Shows a "System health" card + LINE digest; **never auto-fixes** |
| **Daily admin digest** in LINE: money received yesterday, slips waiting, overdue list, anomalies | Daily | Choose recipients |

### Phase 4 — Quality (ongoing)

1. Bangkok-time helper everywhere (M10).
2. Split `use-invoices-state.ts` into server services + smaller hooks (L7).
3. Server-side report queries with paging (M9); dashboards read allocations (M7).
4. Bring migrations in line with the real database; retire `final-schema.sql` (L1).
5. Delete dead code (L2); escape printed HTML (M11).

---

## 8. Questions for you (plain English)

1. **Old unpaid bills:** should an unpaid bill stay on its own and be listed next to the new bill (recommended), or be added *into* the new bill's total?
2. **"Paid" without typing money:** when you or a staff member choose "paid" without entering an amount, what does it usually mean — cash received but not typed in, forgiven, or a mistake?
3. **Late fees:** should the 100 baht/day keep growing until the tenant pays? Is there a maximum? Should unpaid late fees be charged when a tenant moves out?
4. **Deposit at move-out:** should the deposit first pay off any old unpaid bills, and only the rest be refunded? How do you give refunds (cash/transfer) — do you want to record them?
5. **Deposit at move-in:** where do you normally record the deposit and advance rent? (Registration currently saves 0.)
6. **Tenant left but not settled yet:** should they still get a full monthly bill for the month after they left?
7. **Slip approval:** do tenants always pay the full bill in one transfer, or sometimes part?
8. **Meter staff:** who should be allowed to approve a new meter staff member?
9. **Invoices:** should the system send bills automatically on billing day, or always wait for you to review first?
10. **Final bill:** should the water minimum (170 baht) and the common fee also apply on the move-out bill?
11. **The 23,270 baht of refunds and 8,000 baht of unbilled late fees** — just keep them as a list for you to check, or would you later want a tool to record/close them?
12. **Staff roles:** should LINE admins have limited powers (e.g. approve slips only), like the web roles?
13. **Room transfers:** after each room transfer, did you have to fix the room status by hand?
