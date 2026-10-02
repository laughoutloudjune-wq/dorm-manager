# Operator guide: money in the dorm manager

For the owner. Plain English. Describes what is built in the code on `main` (as of 2026-10-03, after commit `d9923d7`). Anything marked **planned** is not built yet.

**Nothing described here has been applied to production.** The code is on `main`, but the database changes (the `20261002*` migrations) have not been run on the live `ApartmentFlow` database. Several screens degrade or change behaviour until they are: void and the Payments tab ledger need `20261002000000`, recording a payment needs `20261002000500` (and `...000200`), and the action-queue refund/credit sections show "not enabled yet" without `...000200` / `...000300`. Do not deploy the code before the migrations; follow the order in `docs/README-money.md`.

## 1. Words used

- **Invoice (บิล)**: what a tenant owes for a month.
- **Receipt (ใบรับเงิน, payment batch)**: one real transfer or cash payment you received. One receipt can pay several invoices.
- **Allocation**: the part of a receipt that went to one particular invoice.
- **Paid amount**: running total received against one invoice. It is a balance, not a record of when money came in.
- **Void (ยกเลิกการชำระ)**: cancel a receipt by adding reversing entries. The original stays visible. Nothing is deleted.
- **Credit (เครดิต)**: money we hold for a tenant (deposit, prepaid rent, or an overpayment). Not cash received today.
- **Non-cash (หักเครดิต)**: reduces what is owed but no money reached a bank account (for example the deposit used after a tenant abandons a room). It has no receiving account and is not counted as cash received.
- **Receiving account**: the bank account that got the money. It is frozen when you record the payment and does not change if you later change the room's account.
- **Cash basis (เงินเข้าจริง)** versus **billing basis (ตามงวดบิล)**: cash basis is money that actually arrived, by the date it arrived. Billing basis is what was billed and paid against each invoice, filed under the invoice's own period. They differ whenever someone pays late or pays ahead. Reports and the dashboard now say which basis a number is on.

## 2. Golden rules

1. Changing an invoice status never records money. To record money use the Payments tab (or approve a slip, section 4).
2. Never type over a paid amount or total to fix a mistake. Void the wrong payment, then record the right one.
3. Every void needs a reason. Reasons are kept in the audit log (`money_events`).
4. The reconciliation page, the action queue and the discrepancy report only report. They never change data.
5. When a number looks wrong, check which basis (cash or billing) the screen is on before suspecting an error.

## 3. Invoices page (open an invoice, then the tabs)

### Opening an invoice from a link
Pages that list problems (reconciliation, action queue) link straight to the invoice (`/invoices?invoice=<id>`) or tenant (`/tenants?tenant=<id>`). The invoice opens on its month automatically.

### Payments tab ("การชำระเงิน" / "ประวัติการชำระเงิน")
This tab is a ledger view built from receipts and allocations, not from the invoice's cached history.
- A summary strip: billed (ยอดเรียกเก็บ), cash received (รับเงินจริง), credit applied (หักเครดิต), waived (ยกเว้นให้), written off (ตัดหนี้สูญ). Waived and written off always read 0 until adjustments are connected (**planned**).
- One card per receipt, with amount, date, source, receiving account (or "unknown" for old payments with no saved account; credit payments show no account), the slip, and how it was split across invoices. Voided receipts show as ยกเลิกแล้ว with the reversal entries next to the original.
- A **discrepancy notice** appears when the invoice's own balance (total minus paid) does not equal the balance computed from its receipts. It shows the difference. Old invoices with a paid amount but no receipt behind them are labelled "legacy, no receipt record" instead of being called an error.
- A status badge on invoices with a slip shows the slip state (waiting review, approved, partly applied, declined).

### Record a payment
Enter the amount, date and slip if there is one. The system spreads the money over the oldest unpaid invoices linked to this one (carried-forward debt) first. If you enter more than is owed, the extra is kept as tenant credit, not lost. Pressing the button twice, or a slow network retry, will not record it twice. If someone else changed the invoice a moment before you, you get a "stale" error: reload and try again.

### Split a payment
Use when a tenant pays several invoices with one transfer. Pick the invoices and amounts; one receipt is recorded with one allocation per invoice.

### Void a payment
On the receipt card press void. A confirmation explains what will happen (computed on screen, so reload if another admin may have touched it), then type a reason (required). The original receipt remains, reversing entries are added on every invoice it paid, paid amounts go down, and an invoice that no longer covers its total returns from paid to partial or pending. Needs permission `invoice.payment.record`.
Limitations today: voiding does not remove an overpayment credit that same receipt created (check the tenant credit afterwards; flagged for Opus); very old payment entries with no receipt behind them cannot be voided here (an adjustment is **planned**).

### Change status
The status dropdown only changes the label. It does not create a payment or freeze a late fee. In the LINE admin app, setting "paid" by hand is now rejected outright. In the web admin it is still allowed; reconciliation will flag a "paid" invoice that has no money behind it. Moving an invoice into or out of paid re-syncs reward points.

### Edit details / delete
Editing invoice details accepts only a fixed list of fields; amounts for money already received cannot be typed over. Deleting invoices that have recorded payments is refused. Both are written to the audit log.

### Late fee (tab "ค่าปรับและอื่นๆ")
The current month's invoice never accrues a running late fee. The fee is calculated once when the invoice is fully paid or carried forward, then appears as a line on the next invoice. Posting and waiving late fees with a reason and approval is **planned**.

### Discounts, write-offs, corrections
A dedicated discount/write-off/correction action with a reason is **planned**. Today only the existing discount and fee fields exist.

## 4. Slips

Tenants upload slips through LINE; the invoice shows "verifying".
- **Decline** (web or LINE): needs a reason; the tenant is notified; logged.
- **Approve in the LINE admin app**: you must now enter the **confirmed amount** you checked on the slip and the **date/time of the transfer**. The system records that amount, not the invoice balance. Rules: amount must be above zero; the date cannot be in the future; the invoice must be in "verifying" and have a slip attached, otherwise approval is refused. If the amount is less than what is owed it is a partial payment; if more, the extra becomes tenant credit. Approving an invoice whose whole chain is already settled only restores the "paid" label and records no money (a known loose end, finding 76).
- Approving from the web admin is done by recording a payment on the Payments tab with the slip.
- Slip events (submitted, approved, declined) are written to the audit log. If a tenant uploads a new slip while one is waiting, the old image is only kept in that log (finding 78).

## 5. Reconciliation review (menu "ตรวจสอบยอดเงิน", needs `reconciliation.view`)

Press refresh to run all nine checks. Each finding shows severity (high/medium/low), tenant and room, the invoice or receipt, an explanation and a suggested next step. Filter by severity or check type; download CSV. Each finding has buttons that open the invoice or the tenant directly.

How to review:
1. Start with high severity.
2. Open the invoice from the button on the finding.
3. Decide: is the data wrong, or is it an old record from before receipts existed? Many "legacy, no receipt record" findings are expected the first time.
4. If a payment is wrong: void it with a reason, then record the correct one. Do not edit amounts.
5. "Receiving account unknown" is an old payment from before accounts were saved; the true account cannot be recovered.
6. Nothing is fixed by opening the page. Take the CSV to your accountant if unsure.

## 6. Action queue (menu "คิวงานที่ต้องจัดการ", needs `action_queue.view`)

A read-only to-do list with five sections and a count for each:
1. **Slips waiting for review** (status verifying with a slip attached), linking to the invoice.
2. **Late fees waiting for approval**: overdue invoices with a rough estimate of the fee. Estimate only; it is not posted and may differ from the fee the invoice will actually carry (finding 49). Posting/approving a fee here is **planned**.
3. **Refunds still to pay**: refund due minus refund paid. Needs `20261002000200` and `...000300`; shows "not enabled yet" until then. Recording a refund payout is **planned**.
4. **Tenant credits not yet applied**: overpayments held. Needs `...000200`.
5. **Reconciliation results**: the same findings as section 5, summarised.
The page changes nothing.

## 7. Reports and dashboard (cash versus billing)

- **Reports, income tab** has two toggles. "ยอดเรียกเก็บ (ตามงวดบิล)" (billing basis) is one row per invoice, billed versus paid, filed under the invoice's billing period. "รายการรับชำระ (เงินเข้าจริง)" (cash basis rows) is one row per individual payment with its amount, actual date and receiving account, still filed under the invoice's period (so a July invoice paid in August shows under July, with the August date on the row). The cash summary also shows money received in the selected calendar month by actual date. Exports carry the basis in the file's header rows.
- Per-account (bank) breakdown is always cash, from the saved account on each payment. Credit settlements are never attributed to a bank. Voided receipts net to zero.
- **Dashboard** (web): "collected" is cash by date received; "outstanding" is by invoice period. The two are on different bases and labelled so; do not divide one by the other (finding 67). The LINE admin dashboard still shows its old paid figure unlabelled (finding 68, **planned** fix). The daily LINE digest now reads receipts.
- A month's cash total on the billing-period view will not match the bank statement for that calendar month; use the by-date figure or the row dates for that.

## 8. What tenants see

- LINE payment mini-app (`/payment`) and the payment link pages: each pending invoice now carries a **statement**: charged amounts, how much has been received (non-voided receipts only), credit applied, balance, and whether a slip is under review. A late fee shows as charged if one is stored, otherwise as an estimate that is never added to the total (finding 52).
- Some screens are still on the old figures: the link page header balance and the LIFF invoice list for paid invoices (findings 53, 54, 74). Receipt pages now show reversed (voided) payments.
- Showing credit balances and refund status to the tenant is **planned**.

## 9. Move-out money

Vacating a room and settling the final bill are two steps. The settlement planner exists but is **not connected** to the move-out screens, and the atomic settlement function is reserved for Opus review. Refund due, forfeiture with reason and refund payouts as separate recorded facts are **planned**. Abandoned-room deposit use is still recorded as a non-cash credit receipt.

## 10. Discrepancy report tool (for the owner, run on your own computer)

`npm run report:discrepancies -- --redact` scans the whole ledger read-only and writes `findings.csv`, `summary.md` and `proposed-repairs.md`. It cannot write to the database and refuses to run without `DISCREPANCY_CONFIRM_READONLY=yes`. Full steps: `docs/DISCREPANCY-REPORT-HOWTO.md`. Give a reviewer only the `--redact` output. Proposed repairs are text only; approve each category separately.

## 11. If something looks wrong

Do not edit numbers. Note the room, month and what you expected. Open the Payments tab (original and void entries are both visible and the discrepancy notice explains differences). Run the reconciliation page. Record anything unexplained for the developer.

## 12. Still planned (not built)

Adjustments (discount, waiver, write-off, correction) with reasons; posting and waiving late fees with approval; refund payout recording; tenant credit and refund display; atomic move-out settlement and atomic points redemption (Opus); the LINE admin dashboard on the new basis labels; and applying any of this to production.
