# Dorm system check-up — plain English version

**Date:** 29 September 2026
**What I did:** read the whole app and looked (read-only) at the live database.
**What I did NOT do:** change any code or any data.

The technical version, with file names and exact numbers, is in `2026-09-29-system-audit-detailed.md`.

---

## The short version

The money math itself (adding up a bill, splitting a payment, prorating rent) is in good shape and well tested. The problems are around it:

1. **The doors are unlocked.** The database and the file storage can be read and changed by anyone on the internet who knows how. This is the most urgent thing.
2. **"Paid" and "money received" are two separate things in the system**, and they can disagree.
3. **Some money never gets written down**: refunds to tenants who move out, some late fees, and deposits.
4. **A lot of work only happens when someone opens a page**, instead of running by itself on a schedule.

---

## 1. Urgent — security (please fix first)

| Problem | What it means for you |
|---|---|
| **The database has no lock.** | Anyone who opens your website can, with a little know-how, see every tenant's name, phone and bills, change amounts, mark bills paid, or delete everything. |
| **Uploaded files have no lock.** | Deposit slips, contracts and other tenant documents can be listed and downloaded by anyone. Anyone can also upload files. |
| **Anyone can become "meter staff".** | A stranger who adds the meter LINE bot, or opens the staff sign-up link, is allowed straight away to type meter readings — which decide the electricity and water bills. |
| **Anyone can claim a tenant who hasn't linked LINE yet.** | Picking "existing tenant" and typing a room number links that LINE account to the real tenant's record. |
| **Registering on LINE erases the deposit.** | When a tenant registers, their deposit and advance rent are saved as 0 (and sometimes the move-in date is erased). Right now **47 of 79** current tenants show 0 deposit, and 9 have no move-in date. |

---

## 2. Money problems

**a) The same debt can be counted two or three times.**
In August we made each month's bill stand on its own. But the "pull last month's balance into this bill" box is still there, and it's still being used. Example: room 109/1 really owes about 8,666 baht, but its three open bills add up to 17,291 because each one includes the one before it. The tenant's LINE page and the "split payment" screen show these inflated numbers.

**b) Two different "cancel payment" buttons that do different things.**
One lowers the invoice's paid amount but keeps the money in the income report. The other removes it from the report but leaves the invoice showing paid. Neither keeps a record of who cancelled or why.

**c) "Paid" is only a label.**
Choosing "ชำระแล้ว" without entering money still lets the tenant download a real-looking receipt, gives them reward points, and removes the bill from "money owed". Right now 4 bills say "paid" but are short a total of 11,143 baht (these are the old known ones).

**d) Approving a slip in the LINE admin app records the whole bill as paid,** even if the slip was for less. Tenants never type how much they transferred, so there's nothing to compare.

**e) Refunds to tenants who move out disappear.**
When the deposit is bigger than the final bill, the system marks it "paid" and forgets that money is owed back. 6 tenants (101/1, 112/1, 202/1, 204/1, 213/2, 216/2) — **23,270 baht** of refunds with no record of being paid out. Also, old unpaid bills are not taken out of the deposit (216/2 still owes 3,790 for July).

**f) "Tenant abandoned the room" (ทิ้งห้อง) is broken since 22 August.** It stops halfway with an error and leaves the tenant still active.

**g) Deleting a room or a tenant deletes all their past bills and payments.** Your income reports for past months would change. Deleting a draft bill that already has money on it is also allowed (3 drafts hold 15,319 baht right now).

**h) Moving a tenant to another room marks the rooms the wrong way** (new room "available", old room still "occupied"). Monthly billing only bills occupied rooms, so the tenant could be skipped. It looks like you've been fixing this by hand.

**i) Late fees are inconsistent.**
- A late fee is only charged on the tenant's *next* bill, so people who leave never get charged (8,000 baht of late fees calculated but never billed).
- The fee is locked at about 1,500 baht (15 days) when the next month's bill is made, and then stops growing — so someone 50 days late pays the same as someone 15 days late.

**j) If two people record a payment on the same bill at the same moment, one can overwrite the other.** Same for two people pressing "Generate invoices" at once — you could get duplicate bills.

**k) Someone allowed to change only "general settings" can also change who has which permissions.**

---

## 3. Things that show wrong or confusing numbers

- Just **opening** the invoice list changes bills in the background (for example, re-applies discount rules, which can change a bill already sent to a tenant).
- Bills of tenants who have given notice are **hidden** from the invoice list.
- Meter readings aren't checked (a new reading lower than last month's, or a huge jump, is accepted). Fixing a reading after the bill is made doesn't fix the bill.
- The dashboard and the income report use different ways of counting "money collected", so they disagree.
- The income report counts deposit credits as if they were cash in the bank.
- The utilities report uses today's prices, not what was actually billed.
- The system uses world standard time (UTC, 7 hours behind Thailand) for "today", so from midnight to 7 am in Thailand it thinks it's still yesterday.
- The printed invoice shows the discount twice.
- "Delete slip" permanently deletes the payment evidence.
- 12 draft bills from past months were never sent.
- The report will start cutting off rows next year (limit of 1,000 rows per request; you have 80 rooms × 12 months = 960).

---

## 4. The plan

**Idea:** let the system do the routine work by itself, but **you approve anything that involves money or looks unusual**. Every automatic job gets an on/off switch, a "hold" button, and a history of what it did.

### Step 1 — Lock the doors (a few days)
- Lock the database and file storage so only the app itself can use them.
- Meter staff must be approved by you before they can type readings.
- LINE registration can only link the account — it can never change deposit, rent or dates.
- Double-check that nobody can create an admin login by themselves.

### Step 2 — One truth for money (1–2 weeks)
- Decide how old unpaid bills should appear (question 1 below) and remove the other way.
- "Paid / partly paid / overdue" is worked out from the real money, not picked by hand. If you want to close a bill without full payment, there's a separate "close — not fully paid" button that asks for a reason.
- One "cancel payment" button that keeps a record (who, when, why) and fixes both the bill and the report.
- Approving a slip always shows the amount, and you confirm it.
- Payments and bill creation run as one step in the database, so two people can't overwrite each other.
- Rooms, tenants and bills with history can be archived, not deleted.
- Fix "abandoned room" and "move to another room".
- A history log of every money change.

### Step 3 — Move-out and late-fee rules (about a week, after your answers)
- A proper move-out statement: old unpaid bills + final bill + unpaid late fees − deposit = what they pay or what you refund. Refunds are written down as money going out.
- Late fees follow one clear rule that you choose.
- Deposits are recorded properly when someone moves in.

### Step 4 — Automation, with you in control (2–3 weeks)

| The system will… | When | You stay in control by… |
|---|---|---|
| Update bill statuses (overdue etc.) | Every morning | Nothing about money changes |
| Send LINE reminders to tenants (before due date, on due date, after) | Daily | Turning it off per tenant; editing the messages |
| Check meter readings for missing rooms and strange numbers | When readings are saved | Staff must confirm flagged readings |
| Prepare all monthly bills once meters are complete | On billing day | Reviewing a "ready to send" list, one click to send all — or auto-send unless you hold it |
| Check slips (amount, date, which account) | When a tenant uploads | Auto-approve only when everything matches exactly (you can switch this off); everything else waits for you |
| Add late fees by the rule you choose | Daily | "Waive" button with a reason |
| Prepare the move-out statement on the move-out date | On the date | You confirm the final numbers and the refund |
| Check the books every night (bills vs money, rooms vs tenants, unsent drafts, unpaid refunds) | Nightly | It only **reports** problems — it never fixes money by itself |
| Send you a daily LINE summary | Every morning | Choosing who receives it |

### Step 5 — Clean-up (ongoing)
Use Thai time everywhere, tidy the very large code files, make reports handle more data, remove unused code, and keep the database setup files matching the real database.

---

## 5. Things found in your data (just a list — nothing was changed)

- 6 move-out refunds with no payout record — 23,270 baht.
- 3 late fees calculated but never billed — 8,000 baht.
- 3 draft bills holding money — 15,319 baht (119/2 July, 212/2 April and May).
- A few rooms where the bill's "paid" number doesn't match the payment records, **besides** the ones we already agreed to leave alone (114/1, 116/1, 201/2, 109/1, 206/1, 207/2): 106/1 March, 110/2 July, 212/2 March and May.
- 11 bills from January–March paid before the payment records existed, so they're missing from the cash report.
- 47 current tenants with 0 deposit, 9 with no move-in date.
- 12 old draft bills never sent.

I will not touch any of these unless you ask.

---

## Your answers (29 Sep 2026)

1. Keep bills separate (recommended way). 2. "Paid" without an amount = no money was received → manual "paid" will be removed. 3. Late fee grows until paid or waived; not charged at move-out (exact meaning being confirmed). 4. Every move-out creates a normal "move-out bill"; advance rent + deposit pay it; the refund is recorded. 5. (clarified in chat) 6. (clarified in chat) 7. Yes — instalments and several overdue bills happen. 8. You approve meter staff. 9. Bills wait for your approval before sending. 10. Yes, water minimum and common fee apply to the move-out bill. 11. Keep the list; you may settle later. 12. The LINE admin is you (phone). 13. The room should become vacant.

The new late-fee / overdue design is in `2026-09-29-late-fee-and-overdue-design.md`.

## 6. Questions for you (original list)

1. **Old unpaid bills:** keep each month's bill separate and simply list older unpaid ones next to it (my recommendation), or add them into the new bill's total?
2. When someone picks **"paid" without typing an amount**, what does it usually mean — cash received but not typed in, forgiven, or a mistake?
3. **Late fees:** should 100 baht/day keep growing until the tenant pays? Is there a maximum? Should unpaid late fees be charged when someone moves out?
4. **Deposit at move-out:** should the deposit pay off old unpaid bills first, and only the rest be refunded? Do you want to record refunds (date, cash or transfer)?
5. **Deposit at move-in:** where do you normally write down the deposit and advance rent?
6. A tenant who **has left but isn't settled yet** — should they still get a full monthly bill?
7. Do tenants sometimes pay **only part** of a bill in one transfer?
8. Who should be allowed to **approve new meter staff**?
9. Should monthly bills be **sent automatically**, or always wait for you to check first?
10. Should the **water minimum (170 baht) and common fee** also apply on the move-out bill?
11. The **refunds (23,270) and unbilled late fees (8,000)** — keep as a list for you to check, or would you like a tool later to record/close them?
12. Should **LINE admins** have limited powers (for example, approve slips only)?
13. After **moving a tenant to another room**, did you have to fix the room status by hand?
