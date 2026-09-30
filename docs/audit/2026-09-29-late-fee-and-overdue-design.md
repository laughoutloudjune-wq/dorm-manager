# Late fees, overdue bills & move-out — new design

**Date:** 29 Sep 2026 (revision 3 — all questions answered) · **Status:** final design, nothing built yet

**Decided so far**

| Topic | Decision |
|---|---|
| Old unpaid bills | Stay on their own bill; never copied into a new bill |
| "Paid" without money | Not allowed — "paid" only when real money covers the bill |
| Late fee | Grows every day until paid or waived; no maximum |
| Late fee at move-out (A) | The move-out bill never gets a late fee **and** unpaid late fees on the leaving tenant's older bills are dropped |
| Leftover deposit (B) | Pays the tenant's older unpaid bills first, then the rest is refunded (rare) |
| Splitting a payment (E) | **You choose** how every payment is split between bills |
| Deposit amount (5) | Entered by you in the tenant profile screen — registration must never overwrite it |
| Early unlock (6) | A tenant can leave before their notice date; you unlock the room so a new tenant can register; the refund/settlement happens later |
| Sending bills | Always wait for your approval |
| Switch-over (C) | **C3 — the past stays exactly as it is.** Nothing already recorded is changed. The new rules start with the **next billing cycle** (bills made 25 Oct 2026). Old bills keep their frozen late fees. |
| Rent for early leavers (F) | **F2 — rent runs to the date in their notice**, even if they hand the key back earlier |
| Meter reading at key return | You always receive the reading when the key is returned, and you type it into the move-out bill — no extra step needed at unlock |
| Un-merge bundled old bills (D) | **Replaced by "the past stays the same".** Old bundled bills are not edited; the system just reads them correctly (see B8) |

---

# Part A — Plain English

## A1. Why it feels messy today

Today a late fee is not kept on the late bill. The system "moves" it onto **next month's** bill as an extra line, and to do that it has to guess the fee on the day next month's bill is made, **lock** it so it stops growing, remember it already moved it, and move it again if the tenant pays later. On top of that, the "pull last month's balance" box copies the **unpaid rent** into the new bill, so one debt sits on two bills.

Your data shows the result. Room 109/1's three open bills read 2,867 + 5,758 + 8,666 = 17,291, but only 8,666 of rent and utilities is really owed. And three late fees (109/1 July, 116/1 June and 116/1 August, 4,500 baht) are marked "already charged" but aren't on any bill; they got lost along the way.

## A2. The new rules

1. **Every bill stands alone.** It only has that month's rent, water, electricity, common fee, other fees and discounts.
2. **A late fee belongs to the late bill itself.** From the day after the due date it grows by 100 baht a day.
3. **The fee stops growing on the day that bill's rent and utilities are fully paid**, counted by the date the money was transferred, not the day you approved it. After that, the fee is a fixed amount still owed on the same bill.
4. **You can waive** all or part of a fee, or **pause** it (for example, when you agree an instalment plan). A reason is always saved.
5. **You decide where every payment goes.** When money comes in, you see all the tenant's open bills and type how much goes to each. Inside one bill, the money covers rent and utilities first, then that bill's late fee.
6. **A bill is "paid" only when rent, utilities and late fee** (minus anything waived) **are all covered by real money.**

## A3. What the tenant sees on LINE

An example from a future cycle (a tenant who didn't pay October or November):

```
ห้อง 1xx — ยอดที่ต้องชำระวันนี้ (15 ธ.ค.)

บิลเดือนธันวาคม              3,000.00   ครบกำหนด 10 ม.ค.

บิลค้างชำระ
  ตุลาคม     ค่าเช่า/ค่าน้ำไฟ     3,000.00
            ค่าปรับ 35 วัน       3,500.00   (เพิ่มวันละ 100 บาทจนกว่าจะชำระ)
  พฤศจิกายน  ค่าเช่า/ค่าน้ำไฟ     3,000.00
            ค่าปรับ 5 วัน          500.00

รวมที่ต้องชำระวันนี้              13,000.00
```

The December bill stays at 3,000. The old bills are shown **next to it, not added into it**. The tenant can pay everything or part of it with one slip, and types the amount they transferred.

## A4. Recording a payment (your manual control)

One screen for everything: a slip from LINE, cash, an instalment, or several overdue bills at once. It works the same on the web and on your phone.

```
รับชำระ — ห้อง 116/1                      ยอดที่รับจริง [ 500 ]  วันที่โอน [ 29/09 ]

 บิล          ค่าเช่า/น้ำไฟ ค้าง   ค่าปรับถึงวันโอน   ยอดค้างรวม    จ่ายบิลนี้
 มิ.ย.              223              ...               ...        [ 0   ]
 ส.ค.             3,230            1,900             5,130        [ 500 ]
                                                 จัดสรรแล้ว 500 / 500  ✔

 [เติมจากบิลเก่าสุด]   (optional helper — only fills the boxes, you can change them)
                                                        [ บันทึก ]
```

- **Save** only works when the amounts you typed add up exactly to the money received.
- Each row shows the late fee **as of the transfer date**, so what you see is what will be recorded.
- Your example: a tenant owes two bills of 500 and pays 500. You type 500 on whichever bill you want. The other bill stays 500 and keeps its late fee counting.

## A5. Move-out (including early unlock)

A move-out has **two dates** that are often different:

| Date | Meaning | Example |
|---|---|---|
| **Left the room** (handover) | The tenant hands back the keys. You press **ปลดล็อกห้องทันที** so a new tenant can register | 15 Sep |
| **Tenancy end / settlement** | The date in their notice; you settle the bill and pay the refund | 30 Sep |

The new flow:

1. The tenant sends a move-out request on LINE, and you approve the date (30 Sep).
2. **The tenant leaves early (15 Sep).** They return the key and you receive the meter reading. You press ปลดล็อกห้องทันที. From then on the room is free, and the new tenant can register and is billed from their own move-in.
3. From the unlock onwards, the old tenant **gets no more monthly bills.**
4. **On the settlement date (30 Sep, or whenever you're ready)** the system prepares the **move-out bill**. It's a normal bill for the last part of the stay:
   - rent per day (monthly rent ÷ 30, rounded down), from the day after the last monthly bill **up to the date in their notice** (30 Sep) — decision F2;
   - water (with the 170 minimum) and electricity from the last monthly reading to **the reading you received when the key was returned**;
   - the common fee;
   - no late fee (A).
5. The advance rent and deposit (from the tenant profile; forfeited if you choose) **pay the move-out bill** as credit, not cash.
6. If credit is left over, it **pays their older unpaid bills** (B). Any unpaid late fees on those older bills are dropped, as decided in A.
7. Whatever is still left is recorded as a **refund waiting to be paid**. When you transfer it, you tap **"refund paid"** and enter the date and the account. It then shows in the reports as money going out.
8. If the credit isn't enough, the rest stays owed on the bill, with no late fee.

## A6. Switching over (decision C3: the past stays the same)

- **Bills made before 25 Oct 2026 are never edited.** Their amounts, their frozen late fees, the late-fee lines already on September bills and the copied rent on old bundled bills all stay exactly as stored.
- **Bills made from 25 Oct 2026 onwards follow the new rules.** Their late fee grows every day until paid or waived.
- **Old bundled bills are only read differently, never changed.** For example, 109/1's September bill includes August's 5,758. The new screens know that and count only September's own 2,908 as owed on that bill, so the tenant's total isn't counted twice. The stored numbers stay untouched.
- The 4,500 of late fees marked "charged" but not on any bill (109/1 July, 116/1 June and August) and the other items on the audit list stay as they are, for you to settle later if you want.

---

# Part B — Technical spec

## B1. Data model

**Keep, with a clear meaning:**

| Column | Meaning in the new model |
|---|---|
| `invoices.total_amount` | This bill's own charges only. **Fixed once sent.** Never includes another bill or any late fee. |
| `invoices.paid_amount` | Cache of `SUM(allocations.amount)` for non-voided batches. Never written directly. |
| `invoices.late_fee_per_day`, `late_fee_start_date` | Copied from settings when the bill is created. |
| `invoices.late_fee_amount` | Cache of the fee accrued (for lists/sorting). The live value always comes from B2. |
| `invoices.status` | Written only by the system (B4), except `draft`, `cancelled`, `closed_unpaid`. |
| `tenants.security_deposit_amount`, `advance_rent_amount` | Written **only** by the admin tenant-profile screen (the registration route stops touching them). |

**Add:**

| New | Purpose |
|---|---|
| `invoices.fee_model` (`legacy` \| `v2`) | Switch-over flag. Bills created before the cut-over are `legacy` and display exactly as stored. |
| `invoices.late_fee_paused_from` (+ reason) | "Pause late fee" |
| `invoices.kind` (`monthly` \| `move_out`) | Replaces `notes LIKE 'ย้ายออก%'`; `move_out` bills never accrue a fee |
| table `late_fee_waivers` (`invoice_id, amount, reason, source manual/move_out/switch_over, created_by, created_at, voided_at`) | Every waiver, including the automatic move-out waiver (A) |
| table `refunds` (`tenant_id, invoice_id, amount, status pending/paid, paid_at, method, payment_method_snapshot, note, created_by`) | Refunds as money out |
| `payment_batches.voided_at, voided_by, void_reason` | Void instead of delete |
| `tenants.handover_date`, `tenants.tenancy_end_date` | The two move-out dates (A5) |
| enum value `closed_unpaid` | Replaces picking "paid" with no money |

**Stop writing for `v2` bills:** `carry_forward_amount`, `invoice_carry_forwards`, `late_fee_line` / `carry_forward` breakdown rows, `locked_late_fee_amount`, `late_fee_billed_at`, `waived_late_fee_amount`, `invoice_arrears_snapshots`.

## B2. One pure function decides everything

```ts
// lib/invoice-balance.ts — no database calls; unit-tested
getInvoiceBalance(invoice, allocations, waivers, asOfBangkok) => {
  charges,        // total_amount
  chargesPaid,    // min(paid, charges)
  feeStopDate,    // earliest of: date cumulative allocations (by paid_at, Bangkok) reached `charges`,
                  //   late_fee_paused_from, tenant handover/settlement (A), or null (still running)
  feeDays,        // late_fee_start_date .. (feeStopDate ?? asOf), inclusive, >= 0; always 0 for kind=move_out
  feeAccrued,     // feeDays * late_fee_per_day
  feeWaived,      // sum of non-voided waivers, capped at feeAccrued
  feePaid,        // max(0, paid - charges)
  amountDue,      // charges + feeAccrued - feeWaived - paid  (>= 0)
  status,         // B4
}
getTenantBalance(openInvoices, …) // per-bill rows + total, for LINE and the payment screen
```

**Legacy bills (`fee_model = 'legacy'`, made before 25 Oct 2026)** go through a read-only adapter and are never written back:
- `charges` = `total_amount − carry_forward_amount` (only the bill's own charges, so a bundled bill doesn't count its source twice);
- `feeAccrued` = the frozen `locked_late_fee_amount` **only if it was never billed elsewhere** (`late_fee_billed_at` is null); otherwise 0, because it already sits on another bill or was lost under the old rules. Legacy fees never grow (decision C3);
- late-fee lines already on a legacy bill stay part of its own charges;
- former tenants' legacy bills show no late fee (decision A).

The fee stop date is **derived from the allocation rows**, never stored. Voiding a payment therefore restarts the fee from the right day automatically. Every screen (admin list, LINE, receipt, reports, dashboard, payment screen) calls this one function.

## B3. Recording money (one Postgres function, one transaction)

`record_payment(tenant_id, amount_received, paid_at, slip?, source, split[])`:

1. `split` is **required**: `[{invoice_id, amount}]`, and `Σ amount = amount_received`. The UI helper "fill oldest first" only pre-fills the form; the server never decides the split.
2. Lock the tenant's open invoices (`FOR UPDATE`). Reject any line greater than that bill's `amountDue` **as of `paid_at`**.
3. Insert one `payment_batches` row and the allocation rows; refresh the `paid_amount`, `late_fee_amount` and `status` caches.
4. Idempotency key unique per tenant.

The same function is used for web payments, LINE slip approval (with the amount and split), move-out credit, and older-bill credit.
`void_payment(batch_id, reason)` sets `voided_at` and refreshes the caches. There are no hard deletes.

## B4. Status (calculated)

| Status | Rule |
|---|---|
| `draft` | Not sent (manual) |
| `pending` | Sent, `amountDue > 0`, today ≤ due date, nothing paid |
| `partial` | Some money received, `amountDue > 0`, today ≤ due date |
| `overdue` | `amountDue > 0` and today > due date (shown as "overdue · partly paid" when money was received) |
| `verifying` | Flag: a slip is waiting for review |
| `paid` | `amountDue = 0` |
| `closed_unpaid` | Closed by you without full payment, reason required |
| `cancelled` | Voided before any money (blocked if allocations exist) |

Manual "paid" is removed from every dropdown (web and LINE).

## B5. Move-out actions

| Action | Does |
|---|---|
| `unlock_room(tenant_id, handover_date)` | Sets `handover_date`, frees the room (vacant), stops monthly billing for this tenant. Keeps `room_id` on the tenant so they show in "waiting to settle". |
| `prepare_move_out_bill(tenant_id, final_readings)` | Creates a `kind=move_out` draft: prorated rent up to `tenancy_end_date` (the notice date, decision F2), utilities from the last monthly reading to the key-return reading you enter, water minimum, common fee. |
| `settle_move_out(tenant_id, forfeit_deposit)` | Applies deposit + advance as credit to the move-out bill, then to older open bills oldest first (B); adds `move_out` waivers for older bills' late fees (A); records any remainder as a `refunds` row (pending); clears `room_id`; sets the tenant inactive. One transaction, idempotent. |
| `mark_refund_paid(refund_id, paid_at, method, account)` | Money out, shown in reports. |

## B6. Scheduled jobs (server, Bangkok time)

| Job | When | Does |
|---|---|---|
| `daily_invoice_refresh` | 06:00 | Refreshes status and the fee cache on open `v2` bills; builds your morning summary |
| `tenant_reminders` (on/off) | 09:00 | LINE: 3 days before due, on the due date, 1 and 7 days after |
| `prepare_monthly_bills` | Billing day | Creates **drafts** for rooms with complete meters; lists missing ones. Never sends |
| `send_approved_bills` | When you press Send | LINE message: this month + older unpaid + total today |

## B7. What gets removed from the code

Late-fee relay and carry checklist in `generateInvoices`; the "pull arrears" UI (`toggleCarryOverFromCandidate`, `recalculateCurrentInvoiceArrears`, the carry/late line editors); `getCarryForwardCandidatesForTarget`, `refreshCarryForwardTargets`, `autoBillUnbilledLateFees`, `computeLateFeeSnapshot`, `getInvoiceOwnOutstanding`; the chain logic and automatic oldest-first split in `applyInvoicePaymentAllocation`; the carry-link rebuild in `save_details`; `cancelPaymentEntry`; the raw `record_payment` payload; `delete_payment_batch` (replaced by void); the late-fee freeze branches in `update_status`; the browser-side status/discount syncs; the current `final_move_out`/`move_out` pair (replaced by B5). Roughly 1,500 lines.

## B8. Switch-over plan

1. **Cut-over:** the next billing cycle (bills made 25 Oct 2026). Those and later bills are `v2`.
2. **No existing row is modified.** Every bill made before the cut-over is tagged `legacy` (the only write to old rows is this tag, done in the migration), and is read through the legacy adapter in B2. That covers bundled bills (109/1, 114/1, 115/1, 116/1, 212/2, drafts 112/1 and 212/2), the September bills that carry an August late-fee line, and frozen fees.
3. **Former tenants' old bills** (114/1, 212/2, 216/2) stay as they are, with no late fee added; the rent still owed stays on the list for you to settle later.
4. Before switching the screens, run old and new calculations side by side on a copy of the data and compare every tenant's balance. Any difference gets explained to you first.

## B9. Tests to write first

- Fee days: due-date boundary, pause, waive > accrued, backdated payment, payment on the start day, move-out bill never accrues.
- Manual split: must add up exactly; a line over `amountDue` is rejected; voiding restores the fee.
- Move-out: credit > bill → older bills → refund; credit < bill; forfeited deposit; rent runs to the notice date even when the key comes back early; no monthly bill after unlock.
- Legacy adapter: 109/1's bundled bills give a total of 8,666 in rent/utilities owed (not 17,291); a frozen fee never grows; legacy rows are never written.
- The B4 status table.
