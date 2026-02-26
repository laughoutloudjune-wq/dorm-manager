"use client";

import { useEffect, useMemo, useState } from "react";

type LiffProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
};

type PaymentHistoryItem = {
  amount?: number;
  mode?: string;
  paid_at?: string;
  slip_url?: string;
};

type AdminLiffInvoice = {
  id: string;
  public_token: string | null;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  slip_url: string | null;
  payment_history: PaymentHistoryItem[] | null;
  tenants?: { full_name?: string | null; phone_number?: string | null } | Array<{ full_name?: string | null; phone_number?: string | null }> | null;
  rooms?: { room_number?: string | null; buildings?: { name?: string | null } | Array<{ name?: string | null }> | null } | Array<{ room_number?: string | null; buildings?: { name?: string | null } | Array<{ name?: string | null }> | null }> | null;
};

const NGROK_SKIP_QUERY = "ngrok-skip-browser-warning=true";

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function formatMoney(value: number | null | undefined) {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(n);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("th-TH");
}

function statusLabel(status: string) {
  switch (status) {
    case "pending":
      return "รอชำระ";
    case "partial":
      return "ชำระบางส่วน";
    case "verifying":
      return "รอตรวจสอบ";
    case "paid":
      return "ชำระแล้ว";
    case "overdue":
      return "เกินกำหนด";
    case "cancelled":
      return "ยกเลิก";
    case "draft":
      return "ฉบับร่าง";
    default:
      return status;
  }
}

function statusClasses(status: string) {
  switch (status) {
    case "paid":
      return "bg-emerald-100 text-emerald-700";
    case "verifying":
      return "bg-amber-100 text-amber-700";
    case "partial":
      return "bg-blue-100 text-blue-700";
    case "overdue":
      return "bg-rose-100 text-rose-700";
    case "pending":
      return "bg-slate-200 text-slate-700";
    default:
      return "bg-slate-100 text-slate-600";
  }
}

export default function AdminLiffPage() {
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string>("");
  const [invoices, setInvoices] = useState<AdminLiffInvoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const baseUrl = useMemo(
    () => (process.env.NEXT_PUBLIC_BASE_URL || "").trim().replace(/\/$/, ""),
    []
  );

  const selectedInvoice = useMemo(
    () => invoices.find((item) => item.id === selectedId) ?? null,
    [invoices, selectedId]
  );

  const visibleInvoices = useMemo(() => {
    if (filter === "all") return invoices;
    return invoices.filter((item) => item.status === filter);
  }, [filter, invoices]);

  const loadInvoices = async (token: string, keepSelection = true) => {
    setRefreshing(true);
    try {
      const statuses =
        filter === "all" ? ["pending", "partial", "overdue", "verifying"] : [filter];
      const response = await fetch("/api/admin-liff/invoices", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true",
        },
        body: JSON.stringify({ accessToken: token, statuses }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data?.error ?? "โหลดบิลไม่สำเร็จ");
        return;
      }
      const rows = (data?.invoices ?? []) as AdminLiffInvoice[];
      setInvoices(rows);
      if (keepSelection) {
        const requestedId = new URLSearchParams(window.location.search).get("invoiceId");
        const preferredId = requestedId || selectedId;
        const found = preferredId ? rows.find((r) => r.id === preferredId) : null;
        setSelectedId(found?.id ?? rows[0]?.id ?? null);
      } else {
        setSelectedId(rows[0]?.id ?? null);
      }
      setMessage(null);
    } catch (error: any) {
      setMessage(error?.message ?? "เกิดข้อผิดพลาดในการโหลดบิล");
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  };

  useEffect(() => {
    const boot = async () => {
      try {
        if (
          window.location.hostname.includes("ngrok") &&
          !window.location.search.includes("ngrok-skip-browser-warning")
        ) {
          const nextUrl = new URL(window.location.href);
          nextUrl.searchParams.set("ngrok-skip-browser-warning", "true");
          window.location.replace(nextUrl.toString());
          return;
        }

        const { default: liff } = await import("@line/liff");
        const liffId = process.env.NEXT_PUBLIC_ADMIN_LIFF_ID;
        if (!liffId) {
          setMessage("ไม่พบ NEXT_PUBLIC_ADMIN_LIFF_ID ในระบบ");
          setLoading(false);
          return;
        }

        await liff.init({ liffId });
        if (!liff.isLoggedIn()) {
          const redirect = new URL(window.location.href);
          redirect.searchParams.set("ngrok-skip-browser-warning", "true");
          liff.login({ redirectUri: redirect.toString() });
          return;
        }

        const p = await liff.getProfile();
        setProfile({
          userId: p.userId,
          displayName: p.displayName,
          pictureUrl: p.pictureUrl,
        });

        const token = liff.getAccessToken() || "";
        setAccessToken(token);
        await loadInvoices(token);
      } catch (error: any) {
        setMessage(error?.message ?? "เชื่อมต่อ LINE LIFF ไม่สำเร็จ");
        setLoading(false);
      }
    };

    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!accessToken || loading) return;
    void loadInvoices(accessToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const applyAction = async (action: "approve_paid" | "update_status", payload?: { status?: string }) => {
    if (!accessToken || !selectedInvoice) return;
    const actionKey = `${action}:${selectedInvoice.id}`;
    setSavingAction(actionKey);
    setMessage(null);
    try {
      const response = await fetch("/api/admin-liff/invoices/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true",
        },
        body: JSON.stringify({
          accessToken,
          invoiceId: selectedInvoice.id,
          action,
          ...(payload ?? {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data?.error ?? "บันทึกสถานะไม่สำเร็จ");
        return;
      }
      setMessage("บันทึกสถานะเรียบร้อย");
      await loadInvoices(accessToken);
    } catch (error: any) {
      setMessage(error?.message ?? "เกิดข้อผิดพลาดในการบันทึกสถานะ");
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

  return (
    <div className="min-h-screen bg-slate-100 px-3 py-4">
      <div className="mx-auto flex w-full max-w-md flex-col gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-slate-500">Apartment Flow - Admin LIFF</p>
              <h1 className="text-lg font-semibold text-slate-900">จัดการใบแจ้งหนี้ (มือถือ)</h1>
            </div>
            {refreshing && (
              <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                กำลังโหลด...
              </span>
            )}
          </div>
          {profile && (
            <p className="mt-2 text-sm text-slate-600">
              {profile.displayName}
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <label className="mb-1 block text-xs font-medium text-slate-500">ตัวกรองสถานะ</label>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
          >
            <option value="all">ทั้งหมด (รอจัดการ)</option>
            <option value="verifying">รอตรวจสอบ</option>
            <option value="pending">รอชำระ</option>
            <option value="partial">ชำระบางส่วน</option>
            <option value="overdue">เกินกำหนด</option>
          </select>
        </div>

        {message && (
          <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700 shadow-sm">
            {message}
          </div>
        )}

        {loading ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm">
            กำลังเชื่อมต่อ LIFF และโหลดข้อมูล...
          </div>
        ) : (
          <>
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-3 py-2 text-xs font-semibold text-slate-500">
                รายการใบแจ้งหนี้ ({visibleInvoices.length})
              </div>
              <div className="max-h-72 overflow-y-auto">
                {visibleInvoices.length === 0 ? (
                  <div className="p-4 text-sm text-slate-500">ไม่พบใบแจ้งหนี้ในสถานะนี้</div>
                ) : (
                  visibleInvoices.map((invoice) => {
                    const rowTenant = toArray(invoice.tenants)[0];
                    const rowRoom = toArray(invoice.rooms)[0];
                    const rowBuilding = toArray(rowRoom?.buildings as any)[0];
                    const rowTotal = Number(invoice.total_amount ?? 0);
                    const rowPaid = Number(invoice.paid_amount ?? 0);
                    const rowRemaining = Math.max(0, rowTotal - rowPaid);
                    const active = selectedId === invoice.id;
                    return (
                      <button
                        key={invoice.id}
                        type="button"
                        onClick={() => {
                          setSelectedId(invoice.id);
                          const url = new URL(window.location.href);
                          url.searchParams.set("invoiceId", invoice.id);
                          window.history.replaceState({}, "", url.toString());
                        }}
                        className={`w-full border-b border-slate-100 px-3 py-3 text-left transition ${
                          active ? "bg-blue-50" : "bg-white"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-900">
                              ห้อง {rowRoom?.room_number ?? "-"} {rowBuilding?.name ? `• ${rowBuilding.name}` : ""}
                            </p>
                            <p className="truncate text-xs text-slate-500">{rowTenant?.full_name ?? "-"}</p>
                            <p className="mt-1 text-xs text-slate-500">
                              ครบกำหนด {formatDate(invoice.due_date)}
                            </p>
                          </div>
                          <div className="text-right">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${statusClasses(invoice.status)}`}>
                              {statusLabel(invoice.status)}
                            </span>
                            <p className="mt-1 text-xs font-medium text-slate-700">
                              คงเหลือ {formatMoney(rowRemaining)}
                            </p>
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {selectedInvoice && (
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      ห้อง {room?.room_number ?? "-"} {building?.name ? `• ${building.name}` : ""}
                    </p>
                    <p className="text-xs text-slate-500">{tenant?.full_name ?? "-"}</p>
                  </div>
                  <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${statusClasses(selectedInvoice.status)}`}>
                    {statusLabel(selectedInvoice.status)}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-xl bg-slate-50 p-2">
                    <p className="text-xs text-slate-500">ยอดรวม</p>
                    <p className="font-semibold text-slate-900">{formatMoney(total)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-2">
                    <p className="text-xs text-slate-500">ชำระแล้ว</p>
                    <p className="font-semibold text-slate-900">{formatMoney(paid)}</p>
                  </div>
                  <div className="col-span-2 rounded-xl bg-blue-50 p-2">
                    <p className="text-xs text-blue-700">คงเหลือ</p>
                    <p className="font-semibold text-blue-900">{formatMoney(remaining)}</p>
                  </div>
                </div>

                <div className="mt-3 space-y-1 text-xs text-slate-500">
                  <p>งวดบิล: {formatDate(selectedInvoice.issue_date)}</p>
                  <p>ครบกำหนด: {formatDate(selectedInvoice.due_date)}</p>
                </div>

                {selectedInvoice.slip_url ? (
                  <div className="mt-4 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      สลิปชำระเงิน
                    </p>
                    <a
                      href={selectedInvoice.slip_url}
                      target="_blank"
                      rel="noreferrer"
                      className="block overflow-hidden rounded-xl border border-slate-200"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={selectedInvoice.slip_url}
                        alt="payment slip"
                        className="h-56 w-full object-cover"
                      />
                    </a>
                    <a
                      href={selectedInvoice.slip_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700"
                    >
                      เปิดรูปสลิป
                    </a>
                  </div>
                ) : (
                  <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-500">
                    ยังไม่มีสลิปแนบในใบแจ้งหนี้นี้
                  </div>
                )}

                {(selectedInvoice.payment_history ?? []).length > 0 && (
                  <div className="mt-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      ประวัติการชำระ
                    </p>
                    <div className="space-y-2">
                      {(selectedInvoice.payment_history ?? []).slice().reverse().slice(0, 5).map((item, idx) => (
                        <div key={`${item.paid_at ?? "n"}-${idx}`} className="rounded-xl border border-slate-200 p-2">
                          <div className="flex items-center justify-between gap-2 text-sm">
                            <span className="font-medium text-slate-800">{formatMoney(item.amount)}</span>
                            <span className="text-xs text-slate-500">{formatDate(item.paid_at ?? null)}</span>
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-2">
                            <span className="text-xs text-slate-500">{item.mode === "full" ? "เต็มจำนวน" : "บางส่วน"}</span>
                            {item.slip_url && (
                              <a
                                href={item.slip_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs font-medium text-blue-700"
                              >
                                ดูสลิป
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-4 space-y-2">
                  <button
                    type="button"
                    onClick={() => void applyAction("approve_paid")}
                    disabled={!!savingAction}
                    className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {savingAction === `approve_paid:${selectedInvoice.id}` ? "กำลังบันทึก..." : "อนุมัติชำระเต็มจำนวน"}
                  </button>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void applyAction("update_status", { status: "verifying" })}
                      disabled={!!savingAction}
                      className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      ตั้งเป็นรอตรวจสอบ
                    </button>
                    <button
                      type="button"
                      onClick={() => void applyAction("update_status", { status: "pending" })}
                      disabled={!!savingAction}
                      className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      ตั้งเป็นรอชำระ
                    </button>
                    <button
                      type="button"
                      onClick={() => void applyAction("update_status", { status: "partial" })}
                      disabled={!!savingAction}
                      className="rounded-xl border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      ตั้งเป็นชำระบางส่วน
                    </button>
                    <button
                      type="button"
                      onClick={() => void applyAction("update_status", { status: "overdue" })}
                      disabled={!!savingAction}
                      className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      ตั้งเป็นเกินกำหนด
                    </button>
                  </div>
                </div>

                <div className="mt-4 flex gap-2">
                  {selectedInvoice.public_token && (
                    <a
                      href={`/payment/${selectedInvoice.public_token}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-center text-xs font-medium text-slate-700"
                    >
                      เปิดหน้าชำระเงิน
                    </a>
                  )}
                  {baseUrl && (
                    <a
                      href={`${baseUrl}/invoices`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-center text-xs font-medium text-slate-700"
                    >
                      เปิดหลังบ้าน
                    </a>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
