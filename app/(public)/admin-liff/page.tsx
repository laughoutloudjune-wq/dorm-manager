"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { meets30DayMoveOutNotice } from "@/lib/move-out-notice";

type TabKey = "dashboard" | "invoices" | "tenants" | "moveouts";

type LiffProfile = { userId: string; displayName: string; pictureUrl?: string };

type AdminLiffInvoice = {
  id: string;
  public_token: string | null;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  rent_amount?: number | null;
  water_bill?: number | null;
  electricity_bill?: number | null;
  common_fee?: number | null;
  additional_fees_total?: number | null;
  carry_forward_amount?: number | null;
  late_fee_amount?: number | null;
  discount_amount?: number | null;
  additional_fees_breakdown?: any[] | null;
  discount_breakdown?: any[] | null;
  late_fee_breakdown?: any[] | null;
  payment_history?: any[] | null;
  slip_url?: string | null;
  tenants?:
    | { full_name?: string | null; line_user_id?: string | null }
    | Array<{ full_name?: string | null; line_user_id?: string | null }>
    | null;
  rooms?:
    | {
        room_number?: string | null;
        buildings?: { name?: string | null } | Array<{ name?: string | null }> | null;
      }
    | Array<{
        room_number?: string | null;
        buildings?: { name?: string | null } | Array<{ name?: string | null }> | null;
      }>
    | null;
};

type DashboardSummary = {
  month: string;
  invoice_count: number;
  tenant_active_count: number;
  total_amount: number;
  outstanding_amount: number;
  by_status: Record<string, number>;
};

type TenantRow = {
  id: string;
  full_name: string;
  phone_number: string;
  line_user_id: string | null;
  move_in_date: string | null;
  room_number: string;
  building_name: string;
};

type MoveOutRequestRow = {
  id: string;
  tenant_id: string;
  tenant_name: string;
  room_number: string;
  building_name: string;
  notice_date: string | null;
  requested_move_out_date: string;
  approved_move_out_date: string | null;
  status: string;
  request_note: string | null;
  admin_note: string | null;
  created_at: string | null;
};

const toArray = <T,>(v: T | T[] | null | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
const fmtDate = (v?: string | null) => (v ? new Date(v).toLocaleDateString("th-TH") : "-");
const fmtMoney = (v?: number | null) =>
  `฿${Number(v ?? 0).toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
const roomCmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
const statusLabel = (s: string) =>
  ({
    pending: "รอชำระ",
    partial: "ชำระบางส่วน",
    verifying: "รอตรวจสอบ",
    paid: "ชำระแล้ว",
    overdue: "เกินกำหนด",
    draft: "ฉบับร่าง",
    cancelled: "ยกเลิก",
  } as Record<string, string>)[s] ?? s;

/** Same set the web admin's SlipDeclineModal offers, so both surfaces send tenants identical wording. */
const LIFF_DECLINE_REASONS = [
  "ยอดเงินในสลิปไม่ตรงกับยอดที่ต้องชำระ",
  "สลิปไม่ชัด อ่านรายละเอียดไม่ได้",
  "เป็นสลิปของรอบบิลอื่นที่ชำระไปแล้ว",
  "โอนเข้าบัญชีที่ไม่ถูกต้อง",
  "ไม่พบรายการเงินเข้าตามสลิปนี้",
];

export default function AdminLiffPage() {
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const [tab, setTab] = useState<TabKey>("dashboard");
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));

  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [invoices, setInvoices] = useState<AdminLiffInvoice[]>([]);
  const [invoiceFilter, setInvoiceFilter] = useState("all");
  const [roomFilter, setRoomFilter] = useState("all");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState("");

  const [tenantQuery, setTenantQuery] = useState("");
  const [tenants, setTenants] = useState<TenantRow[]>([]);

  const [moveOutRequests, setMoveOutRequests] = useState<MoveOutRequestRow[]>([]);
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);
  const [adminNoteByRequest, setAdminNoteByRequest] = useState<Record<string, string>>({});
  const [moveOutSavingAction, setMoveOutSavingAction] = useState<string | null>(null);

  const selectedInvoice = useMemo(
    () => invoices.find((x) => x.id === selectedInvoiceId) ?? null,
    [invoices, selectedInvoiceId]
  );

  const roomOptions = useMemo(() => {
    const s = new Set<string>();
    invoices.forEach((i) => {
      const r = toArray(i.rooms)[0];
      if (r?.room_number) s.add(String(r.room_number));
    });
    return [...s].sort(roomCmp);
  }, [invoices]);

  const visibleInvoices = useMemo(() => {
    const byStatus = invoiceFilter === "all" ? invoices : invoices.filter((i) => i.status === invoiceFilter);
    const byRoom =
      roomFilter === "all"
        ? byStatus
        : byStatus.filter((i) => String(toArray(i.rooms)[0]?.room_number ?? "") === roomFilter);
    return [...byRoom].sort((a, b) => {
      const aBuild = String(toArray(toArray(a.rooms)[0]?.buildings as any)[0]?.name ?? "");
      const bBuild = String(toArray(toArray(b.rooms)[0]?.buildings as any)[0]?.name ?? "");
      const bc = aBuild.localeCompare(bBuild, undefined, { numeric: true, sensitivity: "base" });
      if (bc !== 0) return bc;
      return roomCmp(
        String(toArray(a.rooms)[0]?.room_number ?? ""),
        String(toArray(b.rooms)[0]?.room_number ?? "")
      );
    });
  }, [invoices, invoiceFilter, roomFilter]);

  const postJson = async (url: string, payload: Record<string, unknown>) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? "Request failed");
    return data;
  };

  const loadDashboard = async () => {
    if (!accessToken) return;
    const data = await postJson("/api/admin-liff/dashboard", { accessToken, month });
    setDashboard(data.summary ?? null);
  };

  const loadInvoices = async () => {
    if (!accessToken) return;
    const statuses =
      invoiceFilter === "all"
        ? ["pending", "partial", "overdue", "verifying", "paid", "draft", "cancelled"]
        : [invoiceFilter];
    const data = await postJson("/api/admin-liff/invoices", { accessToken, statuses, month });
    const rows = (data.invoices ?? []) as AdminLiffInvoice[];
    setInvoices(rows);
    setSelectedInvoiceId((prev) => (rows.some((r) => r.id === prev) ? prev : rows[0]?.id ?? null));
  };

  const loadTenants = async () => {
    if (!accessToken) return;
    const data = await postJson("/api/admin-liff/tenants", { accessToken, query: tenantQuery });
    setTenants((data.tenants ?? []) as TenantRow[]);
  };

  const loadMoveOuts = async () => {
    if (!accessToken) return;
    const data = await postJson("/api/admin-liff/move-outs", { accessToken });
    const rows = (data.requests ?? []) as MoveOutRequestRow[];
    setMoveOutRequests(rows);
  };

  useEffect(() => {
    const boot = async () => {
      try {
        const { default: liff } = await import("@line/liff");
        const liffId = process.env.NEXT_PUBLIC_ADMIN_LIFF_ID;
        if (!liffId) throw new Error("Missing NEXT_PUBLIC_ADMIN_LIFF_ID");
        await liff.init({ liffId });
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return;
        }
        const p = await liff.getProfile();
        setProfile({ userId: p.userId, displayName: p.displayName, pictureUrl: p.pictureUrl });
        setAccessToken(liff.getAccessToken() || "");
      } catch (error: any) {
        setMessage(error?.message ?? "เชื่อมต่อ LINE LIFF ไม่สำเร็จ");
      } finally {
        setLoadingAuth(false);
      }
    };
    void boot();
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    void loadDashboard().catch((e) => setMessage(e?.message ?? "โหลด dashboard ไม่สำเร็จ"));
    // Loaded eagerly (not only when the tab is opened) so the tab bar's
    // pending-request dot is accurate as soon as the admin opens the app.
    void loadMoveOuts().catch(() => {});
  }, [accessToken, month]);

  useEffect(() => {
    if (!accessToken) return;
    if (tab === "invoices") void loadInvoices().catch((e) => setMessage(e?.message ?? "โหลดบิลไม่สำเร็จ"));
    if (tab === "tenants") void loadTenants().catch((e) => setMessage(e?.message ?? "โหลดผู้เช่าไม่สำเร็จ"));
    if (tab === "moveouts") void loadMoveOuts().catch((e) => setMessage(e?.message ?? "โหลดคำขอย้ายออกไม่สำเร็จ"));
  }, [accessToken, tab, invoiceFilter, roomFilter, tenantQuery]);

  const runMoveOutAction = async (
    requestId: string,
    action: "approve" | "reject",
    payload: Record<string, unknown>
  ) => {
    if (!accessToken) return;
    const key = `${action}:${requestId}`;
    setMoveOutSavingAction(key);
    setMessage(null);
    try {
      await postJson("/api/admin-liff/move-outs/actions", {
        accessToken,
        requestId,
        action,
        ...payload,
      });
      setMessage(action === "approve" ? "อนุมัติคำขอย้ายออกแล้ว" : "ปฏิเสธคำขอย้ายออกแล้ว");
      await loadMoveOuts();
    } catch (error: any) {
      setMessage(error?.message ?? "บันทึกไม่สำเร็จ");
    } finally {
      setMoveOutSavingAction(null);
    }
  };

  /**
   * Sends the invoice back to the tenant for a new slip. Mirrors the web admin's
   * decline flow (lib/slip-review.ts): status returns to pending/overdue/partial,
   * the slip is unlinked but kept, and the tenant gets a LINE message with the
   * reason.
   */
  const submitDecline = async () => {
    if (!accessToken || !selectedInvoice) return;
    const reason = declineReason.trim();
    if (!reason) return;
    const key = `decline_slip:${selectedInvoice.id}`;
    setSavingAction(key);
    try {
      await postJson("/api/admin-liff/invoices/actions", {
        accessToken,
        invoiceId: selectedInvoice.id,
        action: "decline_slip",
        reason,
      });
      setMessage("ปฏิเสธสลิปแล้ว แจ้งผู้เช่าให้ส่งใหม่เรียบร้อย");
      setDeclineOpen(false);
      setDeclineReason("");
      await Promise.all([loadInvoices(), loadDashboard()]);
    } catch (error: any) {
      setMessage(error?.message ?? "ปฏิเสธสลิปไม่สำเร็จ");
    } finally {
      setSavingAction(null);
    }
  };

  const runInvoiceAction = async (
    action: "approve_paid" | "update_status" | "resend_invoice",
    payload?: Record<string, unknown>
  ) => {
    if (!accessToken || !selectedInvoice) return;
    const key = `${action}:${selectedInvoice.id}`;
    setSavingAction(key);
    try {
      await postJson("/api/admin-liff/invoices/actions", {
        accessToken,
        invoiceId: selectedInvoice.id,
        action,
        ...(payload ?? {}),
      });
      setMessage("บันทึกสำเร็จ");
      await Promise.all([loadInvoices(), loadDashboard()]);
    } catch (error: any) {
      setMessage(error?.message ?? "บันทึกไม่สำเร็จ");
    } finally {
      setSavingAction(null);
    }
  };

  const tenant = toArray(selectedInvoice?.tenants)[0];
  const room = toArray(selectedInvoice?.rooms)[0];
  const building = toArray(room?.buildings as any)[0];
  const total = Number(selectedInvoice?.total_amount ?? 0);
  const paid = Number(selectedInvoice?.paid_amount ?? 0);
  const remaining = Math.max(0, total - paid);
  const workingResend = savingAction === (selectedInvoice ? `resend_invoice:${selectedInvoice.id}` : "");
  const workingApprove = savingAction === (selectedInvoice ? `approve_paid:${selectedInvoice.id}` : "");
  const workingPending = savingAction === (selectedInvoice ? `update_status:${selectedInvoice.id}` : "");
  const workingDecline = savingAction === (selectedInvoice ? `decline_slip:${selectedInvoice.id}` : "");

  return (
    <div className="min-h-screen bg-slate-100 px-3 py-4">
      <div className="mx-auto w-full max-w-md space-y-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Apartment Flow - Admin LIFF</p>
          <h1 className="mt-1 text-lg font-semibold text-slate-900">จัดการหอพักบนมือถือ</h1>
          {profile && <p className="mt-2 text-sm text-slate-600">{profile.displayName}</p>}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
          <div className="grid grid-cols-4 gap-1">
            {([
              ["dashboard", "สรุป"],
              ["invoices", "บิล"],
              ["tenants", "ผู้เช่า"],
              ["moveouts", "ย้ายออก"],
            ] as Array<[TabKey, string]>).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`relative rounded-xl px-2 py-2 text-xs font-semibold ${
                  tab === k ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700"
                }`}
              >
                {label}
                {k === "moveouts" && moveOutRequests.some((r) => r.status === "requested") && (
                  <span
                    className={`absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-white ${
                      tab === k ? "bg-white" : "bg-rose-500"
                    }`}
                    aria-hidden
                  />
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <label className="mb-1 block text-xs font-medium text-slate-500">เดือนข้อมูล</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="box-border w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        {message && <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700">{message}</div>}

        {loadingAuth ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">กำลังเชื่อมต่อ LINE LIFF...</div>
        ) : (
          <>
            {tab === "dashboard" && dashboard && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-xs text-slate-500">ใบแจ้งหนี้</p><p className="text-lg font-bold">{dashboard.invoice_count}</p></div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-xs text-slate-500">ผู้เช่าใช้งาน</p><p className="text-lg font-bold">{dashboard.tenant_active_count}</p></div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-xs text-slate-500">ยอดรวมเดือนนี้</p><p className="text-sm font-bold">{fmtMoney(dashboard.total_amount)}</p></div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-xs text-slate-500">คงค้าง</p><p className="text-sm font-bold text-rose-700">{fmtMoney(dashboard.outstanding_amount)}</p></div>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-3">
                  <p className="mb-2 text-xs font-semibold text-slate-500">สถานะใบแจ้งหนี้</p>
                  {Object.entries(dashboard.by_status).map(([s, c]) => <div key={s} className="flex items-center justify-between text-sm"><span>{statusLabel(s)}</span><span className="font-semibold">{c}</span></div>)}
                </div>
              </div>
            )}

            {tab === "invoices" && (
              <div className="space-y-3">
                <div className="rounded-2xl border border-slate-200 bg-white p-3">
                  <label className="mb-1 block text-xs">สถานะ</label>
                  <select value={invoiceFilter} onChange={(e) => setInvoiceFilter(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm">
                    <option value="all">ทั้งหมด</option><option value="pending">รอชำระ</option><option value="partial">ชำระบางส่วน</option><option value="verifying">รอตรวจสอบ</option><option value="paid">ชำระแล้ว</option><option value="overdue">เกินกำหนด</option>
                  </select>
                  <label className="mb-1 mt-2 block text-xs">ห้อง</label>
                  <select value={roomFilter} onChange={(e) => setRoomFilter(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"><option value="all">ทุกห้อง</option>{roomOptions.map((r) => <option key={r} value={r}>ห้อง {r}</option>)}</select>
                </div>

                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                  <div className="border-b border-slate-200 px-3 py-2 text-xs font-semibold">รายการใบแจ้งหนี้ ({visibleInvoices.length})</div>
                  <div className="max-h-64 overflow-y-auto">
                    {visibleInvoices.map((inv) => {
                      const t = toArray(inv.tenants)[0]; const r = toArray(inv.rooms)[0]; const b = toArray(r?.buildings as any)[0];
                      return <button key={inv.id} type="button" onClick={() => { setSelectedInvoiceId(inv.id); setDeclineOpen(false); setDeclineReason(""); }} className={`w-full border-b border-slate-100 px-3 py-3 text-left ${selectedInvoiceId === inv.id ? "bg-blue-50" : "bg-white"}`}>
                        <p className="text-sm font-semibold">ห้อง {r?.room_number ?? "-"} {b?.name ? `• ${b.name}` : ""}</p>
                        <p className="text-xs text-slate-500">{t?.full_name ?? "-"}</p>
                        <p className="text-xs text-slate-600">{statusLabel(inv.status)} • คงเหลือ {fmtMoney(Number(inv.total_amount ?? 0) - Number(inv.paid_amount ?? 0))}</p>
                      </button>;
                    })}
                  </div>
                </div>
                {selectedInvoice && (
                  <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3">
                    <button
                      type="button"
                      onClick={() => setBreakdownOpen((prev) => !prev)}
                      className="flex w-full items-center justify-between gap-3 text-left"
                    >
                      <span className="text-sm font-semibold">
                        ห้อง {room?.room_number ?? "-"} {building?.name ? `• ${building.name}` : ""}
                      </span>
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600">
                        {breakdownOpen ? "ซ่อนรายละเอียด" : "ดูรายละเอียด"}
                        {breakdownOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </span>
                    </button>
                    <p className="text-xs text-slate-500">{tenant?.full_name ?? "-"}</p>
                    <p className="text-xs text-slate-500">
                      ยอดรวม {fmtMoney(total)} | ชำระแล้ว {fmtMoney(paid)} | คงเหลือ {fmtMoney(remaining)}
                    </p>

                    {breakdownOpen && (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                        <div className="space-y-1">
                          <div className="flex justify-between"><span>ค่าเช่า</span><span>{fmtMoney(Number(selectedInvoice.rent_amount ?? 0))}</span></div>
                          <div className="flex justify-between"><span>ค่าน้ำ</span><span>{fmtMoney(Number(selectedInvoice.water_bill ?? 0))}</span></div>
                          <div className="flex justify-between"><span>ค่าไฟ</span><span>{fmtMoney(Number(selectedInvoice.electricity_bill ?? 0))}</span></div>
                          <div className="flex justify-between"><span>ค่าส่วนกลาง</span><span>{fmtMoney(Number(selectedInvoice.common_fee ?? 0))}</span></div>
                          {Number(selectedInvoice.carry_forward_amount ?? 0) > 0 && (
                            <div className="flex justify-between text-amber-800"><span>ยอดค้างยกมา</span><span>{fmtMoney(Number(selectedInvoice.carry_forward_amount ?? 0))}</span></div>
                          )}
                          {Number(selectedInvoice.additional_fees_total ?? 0) > 0 && (
                            <div className="flex justify-between"><span>ค่าธรรมเนียมเพิ่มเติม</span><span>{fmtMoney(Number(selectedInvoice.additional_fees_total ?? 0))}</span></div>
                          )}
                          {Array.isArray(selectedInvoice.late_fee_breakdown) && selectedInvoice.late_fee_breakdown.length > 0 ? (
                            selectedInvoice.late_fee_breakdown.map((row) => (
                              <div key={row.id} className="flex flex-col text-amber-800">
                                <div className="flex justify-between">
                                  <span>
                                    ค่าปรับล่าช้า - งวด {new Date(row.source_start_date ?? row.snapshot_as_of).toLocaleDateString("th-TH", { month: "short", year: "numeric" })}
                                  </span>
                                  <span>{fmtMoney(Number(row.late_fee_amount))}</span>
                                </div>
                                <span className="text-2xs text-amber-700">
                                  {row.days_overdue} วัน x ฿{row.daily_rate}/วัน
                                </span>
                              </div>
                            ))
                          ) : Number(selectedInvoice.late_fee_amount ?? 0) > 0 ? (
                            <div className="flex justify-between text-amber-800"><span>ค่าปรับล่าช้า</span><span>{fmtMoney(Number(selectedInvoice.late_fee_amount ?? 0))}</span></div>
                          ) : null}
                          {Number(selectedInvoice.discount_amount ?? 0) > 0 && (
                            <div className="flex justify-between text-emerald-800"><span>ส่วนลด</span><span>-{fmtMoney(Number(selectedInvoice.discount_amount ?? 0))}</span></div>
                          )}
                        </div>
                      </div>
                    )}
                    {(() => {
                      const urls = selectedInvoice ? Array.from(new Set([
                        ...(selectedInvoice.slip_url ? [selectedInvoice.slip_url] : []),
                        ...(Array.isArray(selectedInvoice.payment_history) ? selectedInvoice.payment_history.map((h: any) => h.slip_url).filter(Boolean) : [])
                      ])) : [];
                      
                      if (urls.length === 0) {
                        return (
                          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                            ไม่มีสลิปชำระเงิน
                          </div>
                        );
                      }
                      
                      return (
                        <div className="space-y-2">
                          <p className="text-xs font-semibold text-slate-600">สลิปชำระเงิน ({urls.length})</p>
                          <div className="flex overflow-x-auto gap-2 pb-2">
                            {urls.map((url, idx) => (
                              <a
                                key={idx}
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                className="block shrink-0 overflow-hidden rounded-lg border border-slate-200 w-48 h-52"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={url}
                                  alt={`payment slip ${idx + 1}`}
                                  className="h-full w-full object-cover"
                                />
                              </a>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                    <input
                      type="date"
                      value={paymentDate}
                      onChange={(e) => setPaymentDate(e.target.value)}
                      className="box-border w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => void runInvoiceAction("resend_invoice")}
                        disabled={!!savingAction}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 disabled:opacity-60"
                      >
                        {workingResend && <Loader2 size={14} className="animate-spin" />}
                        {workingResend ? "กำลังส่ง..." : "ส่งใบแจ้งหนี้ใหม่"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void runInvoiceAction("approve_paid", { paymentDate })}
                        disabled={!!savingAction}
                        className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                      >
                        {workingApprove && <Loader2 size={14} className="animate-spin" />}
                        {workingApprove ? "กำลังอนุมัติ..." : "อนุมัติชำระเต็ม"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void runInvoiceAction("update_status", { status: "pending" })}
                        disabled={!!savingAction}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 disabled:opacity-60"
                      >
                        {workingPending && <Loader2 size={14} className="animate-spin" />}
                        {workingPending ? "กำลังอัปเดต..." : "ตั้งเป็นรอชำระ"}
                      </button>
                      {selectedInvoice.status === "verifying" && (
                        <button
                          type="button"
                          onClick={() => setDeclineOpen(true)}
                          disabled={!!savingAction}
                          className="col-span-2 inline-flex items-center justify-center gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-60"
                        >
                          {workingDecline && <Loader2 size={14} className="animate-spin" />}
                          {workingDecline ? "กำลังปฏิเสธ..." : "ปฏิเสธสลิป (ให้ผู้เช่าส่งใหม่)"}
                        </button>
                      )}
                    </div>

                    {declineOpen && selectedInvoice.status === "verifying" && (
                      <div className="space-y-2 rounded-xl border border-rose-200 bg-rose-50 p-3">
                        <p className="text-xs font-semibold text-rose-800">
                          เหตุผลที่ปฏิเสธ (ผู้เช่าจะได้รับข้อความนี้ทาง LINE)
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {LIFF_DECLINE_REASONS.map((preset) => (
                            <button
                              key={preset}
                              type="button"
                              onClick={() => setDeclineReason(preset)}
                              className="rounded-lg border border-rose-200 bg-white px-2 py-1 text-[11px] font-semibold text-rose-700"
                            >
                              {preset}
                            </button>
                          ))}
                        </div>
                        <textarea
                          value={declineReason}
                          onChange={(e) => setDeclineReason(e.target.value)}
                          rows={2}
                          placeholder="ระบุเหตุผล"
                          className="box-border w-full rounded-lg border border-rose-300 px-2 py-2 text-sm"
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setDeclineOpen(false);
                              setDeclineReason("");
                            }}
                            disabled={!!savingAction}
                            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-60"
                          >
                            ยกเลิก
                          </button>
                          <button
                            type="button"
                            onClick={() => void submitDecline()}
                            disabled={!!savingAction || !declineReason.trim()}
                            className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                          >
                            ยืนยันปฏิเสธ
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {tab === "tenants" && (
              <div className="space-y-2">
                <div className="rounded-2xl border border-slate-200 bg-white p-3">
                  <input type="text" value={tenantQuery} onChange={(e) => setTenantQuery(e.target.value)} placeholder="ค้นหาผู้เช่า/ห้อง/เบอร์โทร" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                </div>
                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                  <div className="border-b border-slate-200 px-3 py-2 text-xs font-semibold">ผู้เช่า ({tenants.length})</div>
                  <div className="max-h-[28rem] overflow-y-auto">
                    {tenants.map((t) => <div key={t.id} className="border-b border-slate-100 px-3 py-2 text-sm">
                      <p className="font-semibold">ห้อง {t.room_number} • {t.building_name}</p>
                      <p>{t.full_name}</p>
                      <p className="text-xs text-slate-500">โทร: {t.phone_number} | ย้ายเข้า: {t.move_in_date ? fmtDate(t.move_in_date) : "-"} | LINE: {t.line_user_id ? "เชื่อมแล้ว" : "ยังไม่เชื่อม"}</p>
                    </div>)}
                  </div>
                </div>
              </div>
            )}

            {tab === "moveouts" && (
              <div className="space-y-2">
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  หน้านี้ใช้ตรวจสอบและอนุมัติ/ปฏิเสธคำขอย้ายออกเท่านั้น การสรุปยอด (คำนวณค่าเช่า
                  ค่าน้ำไฟ และเงินประกัน) ต้องทำที่หน้าเว็บแอดมินบนคอมพิวเตอร์
                </div>

                {moveOutRequests.length === 0 && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-500">
                    ไม่มีคำขอย้ายออกที่รอดำเนินการ
                  </div>
                )}

                {moveOutRequests.map((request) => {
                  const isExpanded = expandedRequestId === request.id;
                  const noticeYmd = request.notice_date
                    ? String(request.notice_date).slice(0, 10)
                    : request.created_at
                    ? String(request.created_at).slice(0, 10)
                    : "";
                  const adminNote = adminNoteByRequest[request.id] ?? "";
                  const showDepositWarning =
                    request.requested_move_out_date.length > 0 &&
                    noticeYmd.length > 0 &&
                    !meets30DayMoveOutNotice(noticeYmd, request.requested_move_out_date);
                  const isApproving = moveOutSavingAction === `approve:${request.id}`;
                  const isRejecting = moveOutSavingAction === `reject:${request.id}`;

                  return (
                    <div key={request.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                      <button
                        type="button"
                        onClick={() => setExpandedRequestId(isExpanded ? null : request.id)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-900">
                            ห้อง {request.room_number} • {request.building_name}
                          </p>
                          <p className="truncate text-xs text-slate-500">{request.tenant_name}</p>
                          <p className="mt-1 text-xs text-slate-600">
                            ต้องการย้ายออก {fmtDate(request.requested_move_out_date)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span
                            className={`rounded-full px-2 py-1 text-2xs font-semibold ${
                              request.status === "requested"
                                ? "bg-rose-50 text-rose-700"
                                : "bg-blue-50 text-blue-700"
                            }`}
                          >
                            {request.status === "requested" ? "รอตรวจสอบ" : "อนุมัติแล้ว"}
                          </span>
                          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </div>
                      </button>

                      {isExpanded && (
                        <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 px-3 py-3">
                          <div className="space-y-1 text-xs text-slate-600">
                            <p>วันที่แจ้ง (นับ 30 วัน): {fmtDate(noticeYmd)}</p>
                            {request.request_note && <p>หมายเหตุจากผู้เช่า: {request.request_note}</p>}
                            {request.admin_note && <p>หมายเหตุก่อนหน้า: {request.admin_note}</p>}
                          </div>

                          {request.status === "approved" && (
                            <div className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900">
                              อนุมัติให้ย้ายออกวันที่ {fmtDate(request.approved_move_out_date)} แล้ว —
                              ไปสรุปยอดที่หน้าเว็บแอดมินเมื่อถึงวันย้ายออกจริง
                            </div>
                          )}

                          {showDepositWarning && (
                            <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-2xs text-red-900">
                              แจ้งล่วงหน้าไม่ถึง 30 วันตามสัญญา — ผู้เช่าอาจไม่ได้รับเงินประกันคืนเต็มจำนวน
                            </div>
                          )}

                          {request.status === "requested" && (
                            <label className="block text-xs font-medium text-slate-700">
                              หมายเหตุถึงผู้เช่า (ถ้ามี)
                              <textarea
                                value={adminNote}
                                onChange={(e) =>
                                  setAdminNoteByRequest((prev) => ({ ...prev, [request.id]: e.target.value }))
                                }
                                rows={2}
                                className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                                placeholder="เช่น กรุณาคืนกุญแจภายในวันที่ย้ายออก"
                              />
                            </label>
                          )}

                          {request.status === "requested" && (
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  void runMoveOutAction(request.id, "reject", { adminNote: adminNote || null })
                                }
                                disabled={!!moveOutSavingAction}
                                className="inline-flex items-center justify-center gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-60"
                              >
                                {isRejecting && <Loader2 size={14} className="animate-spin" />}
                                {isRejecting ? "กำลังบันทึก..." : "ปฏิเสธ"}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void runMoveOutAction(request.id, "approve", { adminNote: adminNote || null })
                                }
                                disabled={!!moveOutSavingAction}
                                className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                              >
                                {isApproving && <Loader2 size={14} className="animate-spin" />}
                                {isApproving ? "กำลังบันทึก..." : "อนุมัติ"}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
