"use client";

import { useEffect, useState } from "react";
import { ChevronRight, FileText, Gift, History, LogOut } from "lucide-react";

type LiffProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
};

type TenantInfo = {
  id: string;
  full_name: string;
  room_number: string;
  policy_accepted?: boolean;
};

const NGROK_SKIP_QUERY = "ngrok-skip-browser-warning=true";

const moveOutStatusLabel = (status: string) => {
  if (status === "requested") return "รอตรวจสอบ";
  if (status === "approved") return "อนุมัติแล้ว";
  if (status === "rejected") return "ไม่อนุมัติ";
  if (status === "completed") return "เสร็จสิ้น";
  if (status === "cancelled") return "ยกเลิก";
  return status;
};

type TenantTier = "none" | "silver" | "gold" | "platinum";

const TIER_META: Record<Exclude<TenantTier, "none">, { label: string; emoji: string; className: string }> = {
  silver: { label: "Silver", emoji: "🥈", className: "bg-slate-200 text-slate-700" },
  gold: { label: "Gold", emoji: "🥇", className: "bg-amber-100 text-amber-800" },
  platinum: { label: "Platinum", emoji: "💎", className: "bg-indigo-100 text-indigo-800" },
};

export default function PaymentLiffHomePage() {
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showRegisterButton, setShowRegisterButton] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [moveOutStatus, setMoveOutStatus] = useState<string | null>(null);
  const [tier, setTier] = useState<TenantTier>("none");
  const [loading, setLoading] = useState(true);
  const [isAcceptingPolicy, setIsAcceptingPolicy] = useState(false);

  useEffect(() => {
    const boot = async () => {
      try {
        const nextUrl = new URL(window.location.href);
        const invoiceToken = nextUrl.searchParams.get("invoiceToken");
        if (invoiceToken) {
          nextUrl.pathname = `/payment/${invoiceToken}`;
          nextUrl.searchParams.delete("invoiceToken");
          window.location.replace(nextUrl.toString());
          return;
        }

        if (
          window.location.hostname.includes("ngrok") &&
          !window.location.search.includes("ngrok-skip-browser-warning")
        ) {
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

        const nextProfile = await liff.getProfile();
        setProfile({
          userId: nextProfile.userId,
          displayName: nextProfile.displayName,
          pictureUrl: nextProfile.pictureUrl,
        });

        const nextAccessToken = liff.getAccessToken() || "";
        setAccessToken(nextAccessToken);

        const [invoicesRes, moveOutRes, pointsRes] = await Promise.all([
          fetch("/api/payment-liff/invoices", {
            method: "POST",
            headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
            body: JSON.stringify({ accessToken: nextAccessToken }),
          }),
          fetch("/api/payment-liff/move-out", {
            method: "POST",
            headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
            body: JSON.stringify({ action: "get_status", accessToken: nextAccessToken }),
          }),
          fetch("/api/payment-liff/points", {
            method: "POST",
            headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
            body: JSON.stringify({ action: "get_balance", accessToken: nextAccessToken }),
          }),
        ]);

        const invoicesData = await invoicesRes.json().catch(() => ({}));
        if (!invoicesRes.ok) {
          setMessage(invoicesData?.error ?? "โหลดข้อมูลไม่สำเร็จ");
          setLoading(false);
          return;
        }

        const nextTenant = (invoicesData?.tenant ?? null) as TenantInfo | null;
        if (!nextTenant) {
          setMessage(invoicesData?.message ?? "ยังไม่ได้ลงทะเบียนผู้เช่า");
          setShowRegisterButton(true);
          setLoading(false);
          return;
        }

        setTenant(nextTenant);
        setPendingCount(((invoicesData.pending_invoices ?? invoicesData.invoices ?? []) as any[]).length);

        const moveOutData = await moveOutRes.json().catch(() => ({}));
        if (moveOutRes.ok && moveOutData?.move_out_request?.status) {
          setMoveOutStatus(String(moveOutData.move_out_request.status));
        }

        const pointsData = await pointsRes.json().catch(() => ({}));
        if (pointsRes.ok && pointsData?.tier) {
          setTier(pointsData.tier as TenantTier);
        }

        setLoading(false);
      } catch (error: any) {
        setMessage(error?.message ?? "เกิดข้อผิดพลาดในการเชื่อมต่อ LIFF");
        setLoading(false);
      }
    };

    void boot();
  }, []);

  const handleAcceptPolicy = async () => {
    if (!accessToken) return;
    setIsAcceptingPolicy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/payment-liff/accept-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
        body: JSON.stringify({ accessToken, policyVersion: "v1.0" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error ?? "ยอมรับเงื่อนไขไม่สำเร็จ");
      setTenant((prev) => (prev ? { ...prev, policy_accepted: true } : null));
    } catch (error: any) {
      setMessage(error?.message ?? "ยอมรับเงื่อนไขไม่สำเร็จ");
    } finally {
      setIsAcceptingPolicy(false);
    }
  };

  const navItems = tenant
    ? [
        {
          href: "/payment/liff/invoices",
          icon: FileText,
          label: "ใบแจ้งหนี้ปัจจุบัน",
          sub: "ดูและชำระบิลค้างชำระ",
          badge: pendingCount > 0 ? String(pendingCount) : null,
        },
        {
          href: "/payment/liff/invoices/history",
          icon: History,
          label: "ใบแจ้งหนี้ย้อนหลัง",
          sub: "ประวัติการชำระเงินและใบเสร็จ",
          badge: null as string | null,
        },
        {
          href: "/payment/liff/points",
          icon: Gift,
          label: "คะแนนสะสม",
          sub: "ดูคะแนนและประวัติคะแนน",
          badge: null as string | null,
        },
        {
          href: "/payment/liff/move-out",
          icon: LogOut,
          label: moveOutStatus ? "แก้ไขคำขอย้ายออก" : "แจ้งย้ายออก",
          sub: moveOutStatus ? `สถานะ: ${moveOutStatusLabel(moveOutStatus)}` : "แจ้งวันที่ต้องการย้ายออก",
          badge: null as string | null,
        },
      ]
    : [];

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-md space-y-4">
        {loading ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm">
            กำลังโหลดข้อมูล...
          </div>
        ) : (
          <>
            {message && <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{message}</div>}

            {tenant && !tenant.policy_accepted ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold text-slate-900">เงื่อนไขและข้อตกลงการใช้งาน</h2>
                <div className="mt-4 max-h-[40vh] overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                  <p className="font-semibold text-slate-800">นโยบายความเป็นส่วนตัว (Privacy Policy)</p>
                  <p className="mt-2">1. การจัดเก็บข้อมูล: หอพักจะจัดเก็บข้อมูลส่วนบุคคลของท่าน ได้แก่ ชื่อ เบอร์โทรศัพท์ และข้อมูลที่เกี่ยวข้องกับการเช่า เพื่อใช้ในการบริหารจัดการหอพัก</p>
                  <p className="mt-2">2. การใช้ข้อมูล: ข้อมูลของท่านจะถูกใช้เพื่อการออกบิล ติดต่อสื่อสาร และการจัดการที่เกี่ยวข้องกับหอพักเท่านั้น ไม่มีการนำไปเปิดเผยให้บุคคลที่สามโดยไม่ได้รับอนุญาต</p>
                  <p className="mt-2 font-semibold text-slate-800">ข้อตกลงการชำระเงินและการใช้งาน</p>
                  <p className="mt-2">3. การชำระเงิน: ผู้เช่าตกลงที่จะชำระค่าเช่าและค่าใช้จ่ายอื่นๆ ตามที่ระบุในใบแจ้งหนี้ ภายในวันที่กำหนด หากเกินกำหนดอาจมีค่าปรับตามสัญญา</p>
                  <p className="mt-2">4. การตรวจสอบ: เมื่อผู้เช่าแนบสลิปผ่านระบบ จะต้องรอการตรวจสอบจากผู้ดูแลหอพัก การชำระเงินจะสมบูรณ์เมื่อได้รับการยืนยันแล้วเท่านั้น</p>
                  <p className="mt-2">5. ความถูกต้องของข้อมูล: ผู้เช่าขอรับรองว่าข้อมูลสลิปและข้อมูลอื่นๆ ที่ส่งผ่านระบบเป็นความจริงทุกประการ</p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleAcceptPolicy()}
                  disabled={isAcceptingPolicy}
                  className="mt-6 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {isAcceptingPolicy ? "กำลังบันทึก..." : "ยอมรับเงื่อนไขและเข้าสู่ระบบ"}
                </button>
              </div>
            ) : tenant ? (
              <>
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center gap-3">
                    {profile?.pictureUrl ? (
                      <img src={profile.pictureUrl} alt="" className="h-14 w-14 shrink-0 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-blue-100 text-lg font-semibold text-blue-700">
                        {tenant.full_name.slice(0, 1)}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base font-semibold text-slate-900">{tenant.full_name}</p>
                      <p className="text-sm text-slate-500">ห้อง {tenant.room_number}</p>
                    </div>
                    {tier !== "none" && (
                      <span
                        className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${TIER_META[tier].className}`}
                      >
                        {TIER_META[tier].emoji} {TIER_META[tier].label}
                      </span>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  {navItems.map((item) => (
                    <a
                      key={item.href}
                      href={item.href}
                      className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-colors active:bg-slate-50"
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                        <item.icon size={20} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-slate-900">{item.label}</span>
                        <span className="block text-xs text-slate-500">{item.sub}</span>
                      </span>
                      {item.badge && (
                        <span className="shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
                          {item.badge}
                        </span>
                      )}
                      <ChevronRight size={18} className="shrink-0 text-slate-300" />
                    </a>
                  ))}
                </div>
              </>
            ) : null}

            {showRegisterButton && (
              <a
                href="/register"
                className="block rounded-xl bg-blue-600 px-4 py-2.5 text-center text-sm font-semibold text-white"
              >
                ไปหน้าลงทะเบียนผู้เช่า
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
}
