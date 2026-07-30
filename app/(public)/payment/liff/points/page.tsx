"use client";

import { useEffect, useMemo, useState } from "react";

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

type OpenInvoice = {
  id: string;
  issue_date: string;
  due_date: string;
  total_amount: number;
  paid_amount: number;
  status: string;
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
  const [accessToken, setAccessToken] = useState("");
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [balance, setBalance] = useState(0);
  const [history, setHistory] = useState<LedgerRow[]>([]);
  const [config, setConfig] = useState<RewardsConfig | null>(null);
  const [openInvoice, setOpenInvoice] = useState<OpenInvoice | null>(null);
  const [canRedeem, setCanRedeem] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [redeemTarget, setRedeemTarget] = useState<"rent" | "utility">("rent");
  const [redeemPointsInput, setRedeemPointsInput] = useState("");
  const [redeeming, setRedeeming] = useState(false);

  const loadSummary = async (token: string) => {
    const response = await fetch("/api/payment-liff/points", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
      body: JSON.stringify({ accessToken: token }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data?.error ?? "โหลดข้อมูลคะแนนไม่สำเร็จ");
      return;
    }
    if (!data?.tenant) {
      setMessage(data?.message ?? "ยังไม่ได้ลงทะเบียนผู้เช่า");
      return;
    }
    setTenant(data.tenant);
    setBalance(data.balance ?? 0);
    setHistory(data.history ?? []);
    setConfig(data.config ?? null);
    setOpenInvoice(data.openInvoice ?? null);
    setCanRedeem(!!data.canRedeem);
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
        setAccessToken(nextAccessToken);
        await loadSummary(nextAccessToken);
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

  const requestedBaht = useMemo(() => {
    if (!config) return 0;
    const points = Number(redeemPointsInput || 0);
    return Math.round((points / config.points_per_baht) * 100) / 100;
  }, [redeemPointsInput, config]);

  const handleRedeem = async () => {
    if (!accessToken || !openInvoice) return;
    const points = Number(redeemPointsInput || 0);
    if (!points || points <= 0) {
      setMessage("กรุณาระบุจำนวนคะแนนที่ต้องการแลก");
      return;
    }
    if (points > balance) {
      setMessage("คะแนนไม่เพียงพอ");
      return;
    }
    setRedeeming(true);
    setMessage(null);
    try {
      const response = await fetch("/api/payment-liff/points", {
        method: "POST",
        headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
        body: JSON.stringify({
          action: "redeem",
          accessToken,
          invoiceId: openInvoice.id,
          target: redeemTarget,
          pointsToRedeem: points,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error ?? "แลกคะแนนไม่สำเร็จ");
      setMessage(`แลกคะแนนสำเร็จ ได้รับส่วนลด ฿${formatMoney(data.bahtApplied ?? 0)}`);
      setRedeemPointsInput("");
      await loadSummary(accessToken);
    } catch (error: any) {
      setMessage(error?.message ?? "แลกคะแนนไม่สำเร็จ");
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-md space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">คะแนนสะสม</h1>
          <p className="mt-1 text-sm text-slate-500">
            สะสมคะแนนจากการชำระค่าเช่าตรงเวลา แนะนำเพื่อน และการอยู่ต่อเนื่อง
          </p>
          <a href="/payment/liff" className="mt-2 inline-block text-xs font-semibold text-blue-600">
            กลับไปหน้าชำระเงิน
          </a>
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
                  <p className="text-sm text-blue-800">{tenant.full_name} • ห้อง {tenant.room_number}</p>
                  <p className="mt-2 text-3xl font-semibold text-blue-900">{balance.toLocaleString("th-TH")} แต้ม</p>
                  <p className="mt-1 text-sm text-blue-700">≈ ฿{formatMoney(bahtValue)}</p>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-sm font-semibold text-slate-900">แลกคะแนนเป็นส่วนลด</p>
                  {!openInvoice ? (
                    <p className="mt-2 text-sm text-slate-500">ยังไม่มีบิลที่เปิดอยู่ให้แลกส่วนลดในขณะนี้</p>
                  ) : !canRedeem ? (
                    <p className="mt-2 text-sm text-slate-500">ใช้สิทธิ์แลกคะแนนของเดือนนี้ไปแล้ว</p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      <p className="text-xs text-slate-500">
                        บิลงวด {formatDateThai(openInvoice.issue_date)} • คงเหลือ ฿
                        {formatMoney(Math.max(0, openInvoice.total_amount - openInvoice.paid_amount))}
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setRedeemTarget("rent")}
                          className={`flex-1 rounded-xl border px-3 py-2 text-sm font-semibold ${
                            redeemTarget === "rent" ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600"
                          }`}
                        >
                          ส่วนลดค่าเช่า
                        </button>
                        <button
                          type="button"
                          onClick={() => setRedeemTarget("utility")}
                          className={`flex-1 rounded-xl border px-3 py-2 text-sm font-semibold ${
                            redeemTarget === "utility" ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600"
                          }`}
                        >
                          ส่วนลดค่าน้ำ-ไฟ
                        </button>
                      </div>
                      <label className="block text-sm font-medium text-slate-700">
                        จำนวนคะแนนที่ต้องการแลก
                        <input
                          type="number"
                          min={0}
                          max={balance}
                          value={redeemPointsInput}
                          onChange={(event) => setRedeemPointsInput(event.target.value)}
                          className="mt-2 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                          placeholder={`สูงสุด ${config?.max_redemption_baht ?? 0} บาทต่อครั้ง`}
                        />
                      </label>
                      {requestedBaht > 0 && (
                        <p className="text-xs text-slate-500">
                          ≈ ฿{formatMoney(requestedBaht)} (ส่วนลดสูงสุด ฿{formatMoney(config?.max_redemption_baht ?? 0)} ต่อครั้ง)
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleRedeem()}
                        disabled={redeeming}
                        className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                      >
                        {redeeming ? "กำลังแลกคะแนน..." : "แลกคะแนน"}
                      </button>
                    </div>
                  )}
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
