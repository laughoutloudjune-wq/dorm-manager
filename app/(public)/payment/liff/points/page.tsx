"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";

type TenantInfo = {
  id: string;
  full_name: string;
  room_number: string;
};

type LedgerRow = {
  id: string;
  points: number;
  reason: string;
  baht_equivalent: number;
  notes: string | null;
  created_at: string;
};

type RewardsConfig = {
  points_per_baht: number;
  max_redemption_baht: number;
};

const NGROK_SKIP_QUERY = "ngrok-skip-browser-warning=true";

const formatMoney = (value: number) =>
  Number(value || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatDateThai = (value?: string | null) => (value ? new Date(value).toLocaleDateString("th-TH") : "-");

const REASON_LABELS: Record<string, string> = {
  rent_on_time: "ชำระค่าเช่าตรงเวลา",
  streak_bonus: "โบนัสชำระตรงเวลาต่อเนื่อง",
  referral_bonus: "โบนัสแนะนำเพื่อน",
  milestone_3mo: "โบนัสครบ 3 เดือน",
  milestone_1yr: "โบนัสครบ 1 ปี",
  redemption: "แลกคะแนน",
  manual_adjustment: "ปรับปรุงคะแนนโดยผู้ดูแล",
};

export default function RewardsPointsLiffPage() {
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [balance, setBalance] = useState(0);
  const [history, setHistory] = useState<LedgerRow[]>([]);
  const [config, setConfig] = useState<RewardsConfig | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
        const liffId = process.env.NEXT_PUBLIC_PAYMENT_LIFF_ID;
        if (!liffId) {
          setMessage("ไม่พบ NEXT_PUBLIC_PAYMENT_LIFF_ID ใน .env.local");
          setLoading(false);
          return;
        }

        await liff.init({ liffId });
        if (!liff.isLoggedIn()) {
          liff.login({
            redirectUri: `${window.location.origin}${window.location.pathname}?${NGROK_SKIP_QUERY}`,
          });
          return;
        }

        const nextAccessToken = liff.getAccessToken() || "";

        const response = await fetch("/api/payment-liff/points", {
          method: "POST",
          headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
          body: JSON.stringify({ accessToken: nextAccessToken }),
        });
        const data = await response.json();
        if (!response.ok) {
          setMessage(data?.error ?? "โหลดข้อมูลคะแนนไม่สำเร็จ");
          setLoading(false);
          return;
        }
        if (!data?.tenant) {
          setMessage(data?.message ?? "ยังไม่ได้ลงทะเบียนผู้เช่า");
          setLoading(false);
          return;
        }

        setTenant(data.tenant);
        setBalance(data.balance ?? 0);
        setHistory(data.history ?? []);
        setConfig(data.config ?? null);
        setLoading(false);
      } catch (error: any) {
        setMessage(error?.message ?? "เกิดข้อผิดพลาดในการเชื่อมต่อ LIFF");
        setLoading(false);
      }
    };
    void boot();
  }, []);

  const bahtValue = useMemo(() => {
    if (!config) return 0;
    return Math.round((balance / config.points_per_baht) * 100) / 100;
  }, [balance, config]);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-md space-y-4">
        <a href="/payment/liff" className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600">
          <ArrowLeft size={16} /> กลับไปหน้าเมนูผู้เช่า
        </a>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">คะแนนสะสม</h1>
          <p className="mt-1 text-sm text-slate-500">
            สะสมคะแนนจากการชำระค่าเช่าตรงเวลา แนะนำเพื่อน และการอยู่ต่อเนื่อง
          </p>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
            กำลังโหลดข้อมูล...
          </div>
        ) : (
          <>
            {message && <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{message}</div>}

            {tenant && (
              <>
                <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 shadow-sm">
                  <p className="text-sm text-blue-800">
                    {tenant.full_name} • ห้อง {tenant.room_number}
                  </p>
                  <p className="mt-2 text-3xl font-semibold text-blue-900">{balance.toLocaleString("th-TH")} แต้ม</p>
                  <p className="mt-1 text-sm text-blue-700">≈ ฿{formatMoney(bahtValue)}</p>
                  <p className="mt-3 text-xs text-blue-700">
                    ต้องการแลกคะแนนเป็นส่วนลด? เปิดใบแจ้งหนี้ที่ค้างชำระแล้วเลือก "แลกคะแนนสะสม" ได้เลย
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-sm font-semibold text-slate-900">ประวัติคะแนน</p>
                  {history.length === 0 ? (
                    <p className="mt-2 text-sm text-slate-500">ยังไม่มีประวัติคะแนน</p>
                  ) : (
                    <div className="mt-3 space-y-2">
                      {history.map((row) => (
                        <div key={row.id} className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-slate-900">
                              {REASON_LABELS[row.reason] ?? row.reason}
                            </p>
                            <p className="text-xs text-slate-500">{formatDateThai(row.created_at)}</p>
                          </div>
                          <p className={`text-sm font-semibold ${row.points >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                            {row.points >= 0 ? "+" : ""}
                            {row.points.toLocaleString("th-TH")}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
