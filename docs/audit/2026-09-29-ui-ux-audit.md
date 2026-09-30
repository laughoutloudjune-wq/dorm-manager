# UI / UX audit — quality-of-life improvements

**Date:** 29 Sep 2026 · **Nothing was changed.**
**How this was done:** every screen was reviewed from its code (layout, buttons, flows, what each click does), plus a few read-only database counts to see how things are used. I did not log in to the live admin — that would need your password, and just opening the invoice list writes to the database (see the main audit, M1).

Works together with the late-fee/payment design (`2026-09-29-late-fee-and-overdue-design.md`) — several items below are the screens that design needs.

---

## 1. The big picture

The admin web looks clean and consistent (your design system is mostly followed). The friction is not the look — it's **how many clicks and screens a normal task takes**, and **a few places where one wrong tap changes money or status with no confirmation**.

The three jobs you do most — **check slips, record payments, see who owes what** — are spread over several screens and are hardest on the phone, which is where you often do them.

---

## 2. Top 12 quick wins (small effort, big difference)

| # | Problem today | Improvement |
|---|---|---|
| 1 | The LINE alert "slip uploaded" opens the phone admin on the **dashboard, current month** — it ignores which bill the alert was about. If the slip is for last month's bill, you must change the month and hunt for the room. | Open straight on **that bill's slip**, ready to approve/decline. |
| 2 | **Room takeover requests page is not in the menu.** There are **4 requests waiting** that nobody has seen. | Add it to the menu (under Move-outs) with a red count badge. |
| 3 | Every invoice row has a **status dropdown** — one mis-tap changes a bill's status instantly, no confirmation. | Remove from the list (status becomes automatic — see design). Show a status badge instead. |
| 4 | Phone admin: **"อนุมัติชำระเต็ม" records money with one tap**, no confirmation, and is shown on every bill (even ones with no slip). | Only show on bills with a slip; open a confirm sheet showing slip + amount + split. |
| 5 | Tenant LINE payment page **pre-selects bills that are already "waiting for review"**, so the tenant's submit fails with a vague error. | Don't pre-select (or show) bills already under review; say "กำลังตรวจสอบ" on them. |
| 6 | Tenant LINE payment page doesn't show **where to pay** (bank / account number / QR). | Show the account with a **copy** button and the QR on the same screen as the upload. |
| 7 | The invoice list has **no filter by status** — you type "overdue" into the search box. | Quick filter chips: ทั้งหมด · ฉบับร่าง · รอชำระ · รอตรวจสลิป · เกินกำหนด · ชำระแล้ว, each with a count. |
| 8 | The invoice list has **no totals**. | A summary row per month (and per building): billed · received · still owed. |
| 9 | "Print" in the bulk bar prints **only the first** selected invoice. | Print all selected (one page each) or rename to "พิมพ์ใบแรก". |
| 10 | "ใบเสร็จ" (receipt) is available for bills that are **only waiting for review**, and "พิมพ์ใบเสร็จ" is always shown in the bill window. | Receipt only when paid. |
| 11 | Mixed languages: "Send to LINE", "Supabase connected", "Session หมดอายุ", the room-search page is all English. | All Thai (your UI language setting). Remove the "Supabase connected" pill — it means nothing to you. |
| 12 | No warning before leaving a page with unsaved work (meter grid, invoice editor, meter LINE app). | "You have unsaved changes" prompt; meter LINE app keeps a draft on the phone. |

---

## 3. Findings by screen

### 3.1 Menu & layout (`components/admin-nav.ts`, `AdminShell.tsx`)

- **Missing from menu:** Takeovers (`/takeovers`). **Menu has no badges** — you can't see "3 slips waiting / 2 move-out requests" without opening each page.
- **No global search.** Finding a tenant = pick the right page first. Add a search box in the header: type room or name → jump to that tenant's page.
- Menu order doesn't follow the monthly routine. Suggested groups: **วันนี้** (Today) · **รอบบิล** (Meters → Bills → Payments) · **ผู้เช่าและห้อง** (Rooms, Tenants, Move-in/out, Takeovers) · **รายงาน** · **ตั้งค่า** (Settings, Meter staff, Rewards).
- Page title is shown twice-sized in a big frosted header that stays on screen while scrolling — on a laptop it takes a lot of height. Make it slimmer once you scroll.

### 3.2 Dashboard (`app/(admin)/page.tsx`)

- It shows **statistics**, not **what to do**. Replace the top with a **"Today" to-do list** (section 4.1).
- KPI cards link to pages but not to the filtered view (e.g. "บิลรอตรวจสอบ 3" should open the slip queue, not the whole invoice list).
- "Collected" uses a different rule from the reports (main audit M7), so the numbers disagree.
- Anomaly boxes tell you something is wrong but not how to fix it — give each one a button that opens the room/bill concerned.

### 3.3 Invoice list (`components/admin/InvoicesPageView.tsx`)

- **11 columns** in a table that is clipped (not scrollable) on small screens.
- Status dropdown per row (quick win 3). No status filter (7). No totals (8).
- Bills of tenants who gave notice are **hidden** (main audit M2) — yet the code still draws a "moving out" icon that can never appear.
- "เมนู" (menu) button per row just repeats actions available by clicking the row.
- The "Generate monthly bills" button sits next to the month picker — easy to generate for the wrong month; the confirm shows `2026-10` instead of "ตุลาคม 2569".
- Sending to LINE is one bill at a time or a manual multi-select — no "send all drafts for this month" button.
- "เปิดดู" (opened) icon is useful — **45 open bills have never been opened** by the tenant. Make this a filter ("not opened") with a "remind" button.

### 3.4 Invoice window (`components/admin/invoices/InvoiceDetailModal.tsx`)

- 4 tabs (ภาพรวม · มิเตอร์และค่าเช่า · ค่าปรับและรายการอื่นๆ · ประวัติการชำระเงิน). To **approve a slip** you: open bill → read banner → switch to the Payments tab → open "add payment" form → check amount → save. That's 5+ steps for the most common task.
- A **status dropdown** at the top and a **"บันทึกใบแจ้งหนี้" (save)** button that's always visible, even when nothing can be edited.
- Two different "undo payment" buttons (main audit H2): "ยกเลิกรายการ" and the ✕ icon.
- "ลบสลิป" permanently deletes the evidence (main audit M12).
- The whole "carry forward / late fee lines" section disappears with the new design — the window gets much simpler.
- LINE-green button uses a hard-coded colour instead of the design system.

**Proposal:** a simpler bill window with 3 parts on one scroll: **header** (room, tenant, period, status badge, amount due today), **what's on the bill** (editable only while draft), **money** (payments list with void, "record payment", slip viewer). Actions in one bar: Send · Print · Record payment · More (cancel/close unpaid).

### 3.5 Slips & payments

- There is **no slip review queue**. Slips are found by status in the invoice list or through the LINE alert.
- Web: tenant's slip is copied into the payment form automatically (main audit M13); no amount on the slip to compare against.
- Split payment is a separate small window only reachable from inside one bill.

**Proposal:** one **"ตรวจสลิป" queue** (section 4.2) + the **payment screen** from the design (manual split across the tenant's open bills).

### 3.6 Meters — web (`app/(admin)/meters/page.tsx`)

Good: Enter jumps to the next room; negative usage turns red; first-bill rooms explained.
Improve:
- **Progress**: "จดแล้ว 62 / 80 ห้อง" and a filter "ยังไม่จด".
- **Unusual usage warning**: highlight usage > 2× that room's 3-month average or = 0 for an occupied room.
- Show **who recorded** each reading (you / meter staff on LINE) and when.
- The two "ค่าสูงสุดมิเตอร์" boxes are only for rollover — move them into a small "advanced" area.
- Saving writes every room at once — show which rooms changed before confirming.
- No unsaved-changes warning (quick win 12).

### 3.7 Meters — LINE for staff (`app/(public)/meter-liff/page.tsx`)

Good: number keypad, "next" key, electricity/water split, building/floor filter.
Improve:
- Inputs are **very small** (80px wide, extra-small text) — hard to tap while walking. Bigger rows, one room per row card.
- **Keep a draft on the phone** so a LINE reload/closed app doesn't lose half a building of readings.
- Save **per floor** (or auto-save each room) instead of one save at the end.
- Progress count and "skip / vacant" marker per room.
- Optional **photo of the meter** attached to the reading (evidence when a tenant disputes).

### 3.8 Rooms & tenants (`app/(admin)/rooms/page.tsx`, `tenants/page.tsx`, `tenant-editor-modal.tsx`)

- **Nowhere shows how much a tenant owes.** Not on the room card, tenant card or profile. You have to go to invoices and search.
- Tenant info is split between the room panel, the tenant list, the profile modal, move-in wizard and move-out wizard.

**Proposal:** a **tenant page** (section 4.3) that is the single place for one tenant.

### 3.9 Move-out (`app/(admin)/move-outs/page.tsx`, `MoveOutWizard.tsx`, `MoveOutProcessingModal.tsx`)

Good: clear tabs (รอตรวจสอบ · รอย้ายออก · รอสรุปยอด · ปฏิเสธ · ย้ายออกแล้ว) with counts; wizard with steps; autosave of the draft.
Improve (fits the new move-out design):
- The step summary should show the **settlement statement**: move-out bill − deposit/advance → older bills → **refund to pay**.
- A **"refunds waiting to be paid"** list with "mark as paid" (currently refunds aren't tracked at all).
- Short-notice warning (< 30 days) shown on the request card, with the forfeit option pre-suggested but not pre-applied.
- Takeover requests belong here too (quick win 2).

### 3.10 Phone admin — LINE (`app/(public)/admin-liff/page.tsx`)

This is where you work on the go, and it's the weakest screen:
- Ignores the bill link from alerts (quick win 1).
- Month-based: an overdue bill from last month is invisible unless you change the month.
- Bill list is a **tiny scroll box** (256px tall); the chosen bill's details appear below it, off-screen.
- Filters default to "ทั้งหมด" instead of what you usually need (slips waiting).
- Approve records money with one tap, no confirm, no amount (quick win 4); "ตั้งเป็นรอชำระ" also one tap.
- Slip images are small thumbnails that open a new tab.
- Dashboard counts aren't tappable.
- Can't record a cash payment, can't see a tenant's total balance, can't call/LINE the tenant.

**Proposal:** redesign as a phone-first "inbox" (section 4.4).

### 3.11 Tenant LINE app (`app/(public)/payment/liff/*`, `payment/[token]`)

- Two different ways to pay: the multi-bill page and the single-bill page. They behave differently (the single-bill page writes to the database directly and skips checks).
- Pre-selects bills under review → error (quick win 5). No bank/QR on the payment page (6).
- Tenant **doesn't type the amount** they transferred.
- The late fee is just "may have a late fee per dorm policy" — show the real number and "+100 บาท/วัน".
- After sending a slip there's no status tracker ("ส่งแล้ว → กำลังตรวจ → ยืนยันแล้ว / ถูกปฏิเสธ: เหตุผล").
- Bundled old bills make the total look doubled (fixed by the new design).

**Proposal:** one tenant home: **ยอดที่ต้องชำระวันนี้** at the top, bills listed (this month + older), **ชำระเงิน** button → shows account + QR + copy → upload slip + type amount → status tracker. Receipts and history in a second tab.

### 3.12 Registration (`app/register/page.tsx`)

- "ผู้เช่าใหม่ / ผู้เช่าเดิม" choice is confusing and is the security hole from the main audit (C4). Simplify: tenant enters room + phone; if the phone matches the tenant you already created, it links; otherwise it becomes a request you approve.
- The move-in date defaults to today — fine, but show the room's price and deposit so the tenant sees what they're agreeing to.

### 3.13 Settings, rewards, meter staff

- Meter staff delete uses the browser's plain `confirm()` popup — use the app's confirm dialog.
- New meter staff should appear as **"waiting for approval"** at the top with Approve / Reject (ties to the security fix).
- Settings are long forms without "what does this change?" hints for money-affecting fields (rates, due day, late fee per day). Add a one-line hint + "applies from the next bill".

### 3.14 Printing (`use-invoices-state.ts` `buildPrintHtml`)

- Discount printed twice; tenant name/notes not escaped (main audit M11).
- Browser-print layout: add dorm logo, Thai-formatted dates ("25 ต.ค. 2569"), QR for payment, and "ยอดค้างชำระงวดก่อน" box (info only) per the new design.

---

## 4. New screens proposed

### 4.1 "วันนี้" — Today (replaces the top of the dashboard; also the phone home)

```
วันนี้  · จันทร์ 30 ก.ย.
┌──────────────────────────────────────────────┐
│ 🧾 สลิปรอตรวจ                 3   [ตรวจเลย] │
│ ⏰ เกินกำหนด (8 ห้อง, ฿ 41,200) [ดูรายการ]  │
│ 📨 บิลยังไม่ได้ส่ง (ร่าง)        18  [ตรวจ+ส่ง] │
│ 📏 มิเตอร์ยังไม่จด (รอบ ต.ค.)    18  [จดต่อ]   │
│ 🚪 คำขอย้ายออก / ย้ายเข้าแทน    3/4 [ดู]      │
│ 💸 เงินคืนรอโอน                  2  [ดู]      │
│ ⚠️ ข้อมูลผิดปกติ                 1  [ดู]      │
└──────────────────────────────────────────────┘
```
Each line opens the exact filtered list. Empty lines hide themselves.

### 4.2 "ตรวจสลิป" — slip review queue

```
ห้อง 105/2 · สมชาย · ส่งเมื่อ 29 ก.ย. 21:14
[ รูปสลิปใหญ่ ]              ยอดที่ผู้เช่าแจ้ง ฿2,726  · วันที่โอน 29 ก.ย.
                             บิล ก.ย. ค้าง ฿2,726  ✔ ตรงกัน
                             [ อนุมัติ ]  [ แก้ยอด/แบ่งบิล ]  [ ปฏิเสธ ▾ เหตุผล ]
────────────────────────────  ถัดไป ›
```
One slip at a time, big image, amount comparison, next/previous. Same screen on phone and web.

### 4.3 Tenant page (one place for one tenant)

Header: name · room · phone (tap to call) · LINE linked ✔ · **ยอดค้างรวมวันนี้ ฿…**
Tabs: **บิล** (all bills with amount due) · **การชำระเงิน** (payments, void) · **ข้อมูลสัญญา** (dates, deposit, advance — the profile form) · **มิเตอร์** · **ย้ายออก** · **คะแนน**.
Buttons: Record payment · Send reminder · Start move-out · Move room.

### 4.4 Phone admin (LINE) — redesign

```
┌ วันนี้ ┬ สลิป(3) ┬ ค้างชำระ ┬ ผู้เช่า ┬ ย้ายออก ┐   ← bottom tab bar
```
- Opens on **Today**; alerts deep-link to the exact item.
- **สลิป**: the review queue (4.2) — swipe through, big buttons.
- **ค้างชำระ**: everyone who owes, sorted by amount/days, not limited to one month; tap → tenant sheet with "record cash payment", "send reminder", "call".
- **ผู้เช่า**: search → tenant sheet (short version of 4.3).
- Every money action shows a **confirm sheet** (amount, bills, date) before saving.

### 4.5 Monthly billing run (guided)

```
รอบบิล ตุลาคม 2569
① มิเตอร์   62/80 จดแล้ว  ⚠ 2 ผิดปกติ        [ไปจด]
② สร้างบิลร่าง  (พร้อมเมื่อมิเตอร์ครบ)          [สร้าง]
③ ตรวจบิล   80 ร่าง · 3 มีการเปลี่ยนแปลงจากเดือนก่อนเกิน 30%  [ตรวจ]
④ ส่ง LINE   [ส่งทั้งหมด 80]  (ยังไม่เชื่อม LINE: 0)
⑤ ติดตาม    เปิดอ่านแล้ว 52/80 · ชำระแล้ว 30/80  [เตือนคนที่ยังไม่เปิด]
```
Turns the monthly routine into a checklist and matches "wait for my approval before sending".

---

## 5. Consistency clean-up (behind the scenes)

- LINE pages use their own colours (184 raw colour classes) — fine for LINE, but define a small shared LINE style so the tenant, meter and phone-admin apps look like one product.
- Replace remaining hand-made buttons/inputs in the big admin files with the design-system components (InvoiceDetailModal 31 buttons, Settings 23, MoveOutWizard 15).
- Delete the unused `SettingsView.tsx`.
- One date format everywhere (Thai Buddhist year, e.g. "25 ต.ค. 2569"); one money format.
- Use the app's confirm dialog everywhere (no browser `confirm()` / `alert()`).

---

## 6. Suggested order

| Step | What | Why first |
|---|---|---|
| 1 | Quick wins 1, 2, 4, 5, 6, 12 | Stop mistakes and missed requests; mostly small changes |
| 2 | Slip review queue (4.2) + payment screen (from the design) | Your most frequent task |
| 3 | Phone admin redesign (4.4) | Where you work on the go |
| 4 | Tenant page (4.3) + "Today" (4.1) | Fewer screens to answer "who owes what" |
| 5 | Monthly billing run (4.5) + meter improvements | Makes the monthly routine a checklist |
| 6 | Tenant LINE home redesign | Fewer questions from tenants, fewer wrong slips |
| 7 | Consistency clean-up | Ongoing |

Steps 2–6 should be built **together with** the new payment/late-fee rules, not before — otherwise those screens would be built twice.

---

## 7. Questions for you

1. On the phone, what do you do most — approve slips, check who owes, record cash, or move-outs? (Decides what the phone app opens on.)
2. Do you want tenants to **type the amount** they transferred when sending a slip? (Recommended — makes approval a one-glance check.)
3. Would a **photo of the meter** from staff be useful, or is the number enough?
4. For the invoice printout — do you print on paper, or only send by LINE? (Decides how much effort goes into the print layout.)
5. Are the takeover requests (4 waiting) something you still use, or can "someone else wants this room" be merged into the normal move-in flow?
