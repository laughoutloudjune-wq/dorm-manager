# Operator guide: money in the dorm manager

For the owner. Plain English. Describes what exists in the app today; anything marked **planned** is not built yet.
Note: the new money safety features only take effect after the database changes (migrations) are applied to production. Until the owner approves and applies them, parts of this guide describe the intended behaviour. Ask before relying on a feature that says "needs migration".

## 1. Words used

- **Invoice (บิล)**: what a tenant owes for a month.
- **Receipt (ใบรับเงิน, payment batch)**: one real transfer or cash payment you received. One receipt can pay several invoices.
- **Allocation**: the part of a receipt that went to one particular invoice.
- **Paid amount**: running total received against one invoice. It is a balance, not a record of when money came in.
- **Void (ยกเลิกการชำระ)**: cancel a receipt by adding a reversing entry. The original stays visible. Nothing is deleted.
- **Credit (เครดิต)**: money we hold for a tenant (deposit, prepaid rent, or an overpayment). Not cash received today.
- **Non-cash**: reduces what is owed but no money reached a bank account (for example the deposit used after a tenant abandons a room). It shows as a credit, has no receiving account, and should not be counted as income.
- **Receiving account**: the bank account that got the money. It is frozen when you record the payment and does not change if you later change the room's account.

## 2. Golden rules

1. Changing an invoice status never records money. To record money, use the Payments tab.
2. Never type over a paid amount or total to fix a mistake. Void the wrong payment, then record the right one.
3. Every void needs a reason. Reasons are kept in the audit log.
4. The reconciliation page only reports. It never changes data.

## 3. Actions in the Invoices page (open an invoice, then the tabs)

### Record a payment (tab "การชำระเงิน")
Enter the amount, the date and the slip if there is one. The system spreads the money over the oldest unpaid invoices linked to this one (carried-forward debt) first. If you enter more than is owed, the extra is kept as tenant credit, not lost. Pressing the button twice, or a slow network retry, will not record it twice. If someone else changed the invoice a moment before you, you get a "stale" error: reload and try again.

### Split a payment
Use when a tenant pays several invoices with one transfer and you want to choose exactly how much goes to each. Pick the invoices and amounts; the receipt is recorded once with one allocation per invoice.

### Void a payment
On the payment card press cancel/void. Confirm, then type a reason (required). The original receipt remains, reversing entries are added on every invoice it paid, the paid amounts go down, and an invoice that no longer covers its total returns from paid to partial or pending. Limitations today: a void does not remove any overpayment credit that same receipt created (check the tenant credit afterwards; flagged for fix); very old payment entries that have no receipt behind them cannot be voided here (an adjustment is **planned**).

### Change status
The status dropdown only changes the label. It does not create a payment, a late fee or a freeze of one. Marking an invoice "paid" with no payment recorded will be flagged by reconciliation as a status/balance mismatch. Moving an invoice into or out of paid also re-syncs reward points.

### Late fee (tab "ค่าปรับและอื่นๆ")
The current month's invoice never accrues a running late fee. The fee is calculated once when the invoice is fully paid or carried forward, then appears as a line on the next invoice. Posting and waiving late fees with a clear reason and approval is **planned**.

### Confirm or decline a tenant slip
Tenants upload slips through LINE. The invoice shows "verifying". Decline needs a reason and the tenant is notified. Approving in the LINE admin app records the confirmed payment and needs a slip.

### Discounts, write-offs, corrections
A dedicated discount/write-off/correction action with reason is **planned**. Today only the existing discount and fee fields on the invoice exist.

## 4. Reconciliation review (menu "ตรวจสอบยอดเงิน", needs the reconciliation permission)

Press refresh to run all checks. Each finding shows severity (high/medium/low), the tenant and room, the invoice or receipt id (first characters), an explanation and a suggested next step. Filter by severity or check type, and download CSV.

How to review:
1. Start with high severity.
2. Open the invoice from the invoices page by room and period (direct links from a finding are **planned**).
3. Decide: is the data wrong, or is it just an old record from before receipts existed? Many "legacy, no receipt record" findings are expected the first time and are not new breakage.
4. If a payment is wrong: void it with a reason, then record the correct one. Do not edit amounts.
5. If a finding says the receiving account is unknown, it is an old payment from before accounts were saved; the true account cannot be recovered.
6. Nothing is fixed by opening the page. Take the CSV to your accountant if unsure.

## 5. Action queue
A queue listing what needs your attention (slips waiting, payments needing review, overdue items) is **planned**. It does not exist yet; use the invoice filters and the reconciliation page.

## 6. What tenants see
Tenants use the LINE payment mini-app (`/payment`). It lists their invoices with total, paid amount and status, and lets them upload a slip. Showing credit balances, refund status and a statement of receipts to the tenant is **planned**.

## 7. Move-out money
Vacating a room and settling the final bill are two steps. Refund due, deposit forfeiture (with reason) and refund payout recording as separate facts are **planned**; the planner exists but is not connected to the move-out screens.

## 8. If something looks wrong
Do not edit numbers. Note the room, month and what you expected. Check the invoice's payment cards (original and void entries are both visible). Run the reconciliation page. Record anything unexplained for the developer.
