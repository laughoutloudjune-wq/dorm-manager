# Dorm Manager — Full System Analysis

A comprehensive review of architecture, UI/UX, workflow, performance, and code quality across the entire codebase.

---

## Executive Summary

The system is a functional, feature-rich apartment management platform. However, it has grown organically and now carries significant technical debt that impacts maintainability, performance, and user experience. The biggest issues are **massive monolithic components**, **inconsistent data fetching patterns**, **duplicated business logic**, and **missing client-side state management**. Below is a prioritized breakdown.

---

## 🔴 Critical Issues (High Impact)

### 1. God Components — Still a Major Problem

Despite recent refactoring, two files remain far too large and carry too many responsibilities:

| File | Lines | Concern |
|---|---|---|
| [InvoicesPageView.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/components/admin/InvoicesPageView.tsx) | **5,190** | Invoice generation, editing, payment recording, LINE sending, deletion, bulk actions, receipts, room transfers, arrears calculations |
| [tenant-editor-modal.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/components/admin/tenant-editor-modal.tsx) | **2,064** | Tenant CRUD, lease management, room transfer calculations, deposit slip uploads, LINE unlinking, payment history |
| [tenants/page.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/app/(admin)/tenants/page.tsx) | **1,327** | Duplicates ~80% of tenant-editor-modal logic (types, utilities, state) AND also manages the page-level list/filter UI |

> [!CAUTION]
> `tenants/page.tsx` and `tenant-editor-modal.tsx` share nearly identical type definitions, utility functions (`toNumber`, `formatMoney`, `escapeHtml`, `roomNumberCompare`, `tenantRoomNumber`, etc.), and state management. This duplication means **every bug fix must be applied in two places**. They should share a common module.

**Recommended decomposition for InvoicesPageView:**
- `InvoiceGenerationWizard` — the multi-step invoice creation flow
- `InvoiceDetailPanel` — viewing/editing a single invoice
- `InvoicePaymentRecorder` — recording payments, partial payments
- `InvoiceBulkActions` — bulk send, bulk delete, bulk status change
- `InvoiceListView` — the filterable table/list
- `useInvoiceData` hook — shared data fetching + mutations

---

### 2. Duplicated Business Logic Across Client & Server

Business logic for move-out calculations, pro-rate rent, utility charges, and late fees exists in **multiple places**:

- [tenants/page.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/app/(admin)/tenants/page.tsx) — `calculateTransferRentProration`
- [tenant-editor-modal.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/components/admin/tenant-editor-modal.tsx) — move-out rent calculation, deposit logic
- [MoveOutTab.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/components/admin/MoveOutTab.tsx) — same calculations duplicated
- [MoveOutProcessingModal.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/components/admin/MoveOutProcessingModal.tsx) — yet another copy
- [InvoicesPageView.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/components/admin/InvoicesPageView.tsx) — invoice generation duplicates rate/proration logic
- [invoice-ledger.ts](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/lib/invoice-ledger.ts) — server-side payment allocation

> [!IMPORTANT]
> Extract shared calculation logic into `lib/` modules:
> - `lib/rent-proration.ts` — pro-rate, daily rent, transfer calculations
> - `lib/move-out-settlement.ts` — deposit, utility, fee total calculations
> - `lib/format.ts` — `toNumber`, `formatMoney`, `escapeHtml`, date helpers

---

### 3. Inconsistent Data Fetching — No Shared Cache

Every page fetches its own data independently using raw `supabase.from()` calls with no caching, deduplication, or background revalidation:

| Page | Fetching Pattern |
|---|---|
| Dashboard | `useEffect` → 5× parallel `supabase.from()` → `setState` |
| Tenants | `useEffect` → 6× separate `loadX()` → `setState` |
| Rooms | `useSWR` ✅ (recently added) |
| Meters | `useEffect` → `fetchData()` → `setState` |
| Invoices | `useEffect` → complex multi-query → `setState` |
| Move-Outs | `useSWR` ✅ (recently added) |
| Settings | `useEffect` → `setState` |

> [!TIP]
> Standardize on **SWR everywhere**. Create custom hooks like `useRooms()`, `useTenants()`, `useInvoices(filters)` in `lib/hooks/`. This gives you:
> - Automatic caching and deduplication
> - Background revalidation (stale-while-revalidate)
> - Optimistic updates
> - Shared state across pages (navigate Tenants → Dashboard and data is already cached)

---

## 🟡 Significant Issues (Medium Impact)

### 4. Dashboard Loads ALL Data

The [dashboard](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/app/(admin)/page.tsx) fetches **every room, every tenant, every invoice, and every meter reading** on mount to compute KPIs client-side. For a property with 200+ rooms and years of invoices, this will become slow.

**Fix:** Create a server-side API endpoint `/api/admin/dashboard-stats` that computes KPIs with SQL aggregations (COUNT, SUM, GROUP BY) and returns only the summary numbers. This reduces the payload from potentially megabytes to a few KB.

---

### 5. Remaining `setStatus` / `setError` / `alert()` Calls

Toast migration is incomplete. These files still use old patterns:

| File | Pattern | Count |
|---|---|---|
| [tenants/page.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/app/(admin)/tenants/page.tsx) | `setStatus()` | ~20+ calls |
| [meters/page.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/app/(admin)/meters/page.tsx) | `setStatus()` | ~3 calls |
| [settings/page.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/app/(admin)/settings/page.tsx) | `alert()` | Multiple |
| [dashboard/page.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/app/(admin)/page.tsx) | `setError()` | ~3 calls |
| [meter-staff/page.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/app/(admin)/meter-staff/page.tsx) | `setError()` | Multiple |
| [takeovers/page.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/app/(admin)/takeovers/page.tsx) | `setError()` | Multiple |
| [LIFF payment page](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/app/(public)/payment/liff/page.tsx) | `alert()` | 1 call |

---

### 6. Missing Loading States / Skeleton Loaders

Only Rooms and Move-Outs pages have skeleton loaders. These pages still show bare "loading text":

- **Dashboard** — shows `-` for KPIs but no visual skeleton
- **Tenants** — shows nothing while `isPageLoading` is true
- **Meters** — has a simple pulse dot but no table skeleton
- **Invoices** — shows inline "กำลังโหลดใบแจ้งหนี้..."
- **Settings** — no loading state at all
- **Reports** — no loading state

---

### 7. No Optimistic Updates

Every mutation (save tenant, record payment, update status) follows the pattern:
1. Call API
2. Wait for response
3. Manually splice the result into local state **or** call `reload()`

This makes the UI feel sluggish. With SWR's `mutate()`, you can implement optimistic updates: update UI immediately, then validate in the background.

---

### 8. Tenant Editor State Explosion

[tenants/page.tsx](file:///c:/Users/laugh/Documents/Webapp/dorm-manager/app/(admin)/tenants/page.tsx) has **37 separate `useState` calls** (lines 313–359). This is a symptom of the page managing too many concerns. The modal state should be encapsulated in a `useTenantEditor()` custom hook or `useReducer`.

---

## 🟢 Improvement Opportunities (Lower Priority)

### 9. Type Safety

Extensive use of `any` types throughout the codebase:

```typescript
// Dashboard (line 63-67)
const [rooms, setRooms] = useState<any[]>([]);
const [tenants, setTenants] = useState<any[]>([]);
const [invoices, setInvoices] = useState<any[]>([]);
```

Create shared types in `types/` and import them everywhere. The `TenantRow`, `RoomRow`, and `InvoiceRow` types are defined differently in every file.

---

### 10. No Real-Time Updates

When a tenant uploads a slip in the LIFF page, the admin panel doesn't know until they manually refresh. Supabase has built-in realtime subscriptions that could push updates:

```typescript
supabase.channel('invoices')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'invoices' }, 
    payload => { /* update local state or trigger SWR revalidation */ })
  .subscribe()
```

This would be especially useful for the "บิลรอตรวจสอบ" KPI on the dashboard.

---

### 11. Notification Consistency

LINE notifications are fire-and-forget with no retry or status tracking:

```typescript
// From LIFF page
void fetch("/api/notify-slip-upload", { ... }); // No error handling
```

If the notification fails, neither the admin nor the tenant knows. Consider:
- Logging notification attempts to a `notification_logs` table
- Showing a "notification sent" / "notification failed" indicator in the admin panel

---

### 12. Mobile UX on Admin Panel

The admin panel uses `md:pl-64` for sidebar spacing but the sidebar behavior on mobile isn't optimized. The meter reading table (`min-w-[640px]`) forces horizontal scrolling on phones. For meter staff who read meters on-site, this is a significant usability issue.

---

### 13. Migration Files Scattered

There are **12 migration SQL files** in the project root. These should be organized into a `migrations/` directory with a naming convention like `001_initial.sql`, `002_invoice_ledger.sql`, etc.

---

### 14. Missing Error Boundaries

No React Error Boundaries exist in the component tree. If `InvoicesPageView` throws during render (e.g., from bad data), the entire admin panel crashes. Add error boundaries around major page sections.

---

## 📋 Prioritized Action Plan

| Priority | Task | Impact | Effort |
|---|---|---|---|
| 🔴 1 | Extract shared types & utility functions into `lib/` | Eliminates duplication bugs | Low |
| 🔴 2 | Create SWR data hooks (`useRooms`, `useTenants`, etc.) | Caching, dedup, consistent fetching | Medium |
| 🔴 3 | Decompose `InvoicesPageView` into sub-components | Maintainability, testability | High |
| 🟡 4 | Server-side dashboard KPI aggregation | Performance at scale | Medium |
| 🟡 5 | Complete toast migration (tenants, meters, settings, dashboard) | UX consistency | Low |
| 🟡 6 | Add skeleton loaders to remaining pages | Perceived performance | Low |
| 🟡 7 | Reduce `tenants/page.tsx` state with `useReducer` | Code quality | Medium |
| 🟢 8 | Replace `any` types with shared interfaces | Type safety | Low-Medium |
| 🟢 9 | Add Supabase Realtime for slip upload notifications | Real-time admin UX | Medium |
| 🟢 10 | Mobile-optimize meter reading tables | Field staff UX | Medium |
| 🟢 11 | Organize migration files | Project hygiene | Trivial |
| 🟢 12 | Add React Error Boundaries | Crash resilience | Low |

---

## Summary

The system works well for its current scale but will hit maintainability and performance walls as it grows. The **highest ROI work** is:

1. **Extract shared code** (`lib/format.ts`, `lib/rent-calculations.ts`, shared types) — stops the duplication bleeding
2. **Standardize on SWR hooks** — single biggest architectural improvement for data flow
3. **Break up InvoicesPageView** — it's 5,190 lines and a ticking time bomb for regressions

Which of these would you like to tackle first?
