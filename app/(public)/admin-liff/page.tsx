"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";

type TabKey = "dashboard" | "invoices" | "tenants";

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

  const [tenantQuery, setTenantQuery] = useState("");
  const [tenants, setTenants] = useState<TenantRow[]>([]);

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
  }, [accessToken, month]);

  useEffect(() => {
    if (!accessToken) return;
    if (tab === "invoices") void loadInvoices().catch((e) => setMessage(e?.message ?? "โหลดบิลไม่สำเร็จ"));
    if (tab === "tenants") void loadTenants().catch((e) => setMessage(e?.message ?? "โหลดผู้เช่าไม่สำเร็จ"));
  }, [accessToken, tab, invoiceFilter, roomFilter, tenantQuery]);

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

  return (
    <div className="min-h-screen bg-slate-100 px-3 py-4">
      <div className="mx-auto w-full max-w-md space-y-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Apartment Flow - Admin LIFF</p>
          <h1 className="mt-1 text-lg font-semibold text-slate-900">จัดการหอพักบนมือถือ</h1>
          {profile && <p className="mt-2 text-sm text-slate-600">{profile.displayName}</p>}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
          <div className="grid grid-cols-3 gap-1">
            {([
              ["dashboard", "สรุป"],
              ["invoices", "บิล"],
              ["tenants", "ผู้เช่า"],
            ] as Array<[TabKey, string]>).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`rounded-xl px-2 py-2 text-xs font-semibold ${
                  tab === k ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700"
                }`}
              >
                {label}
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
                      return <button key={inv.id} type="button" onClick={() => setSelectedInvoiceId(inv.id)} className={`w-full border-b border-slate-100 px-3 py-3 text-left ${selectedInvoiceId === inv.id ? "bg-blue-50" : "bg-white"}`}>
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
                                <span className="text-[10px] text-amber-700">
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
                    </div>
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
          </>
        )}
      </div>
    </div>
  );
}
