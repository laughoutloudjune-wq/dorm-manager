"use client";

import { useEffect, useState } from "react";

type LiffProfile = {
  userId: string;
  displayName: string;
};

type TenantInfo = {
  id: string;
  full_name: string;
  room_number: string;
};

type MoveOutRequest = {
  id: string;
  requested_move_out_date: string;
  approved_move_out_date?: string | null;
  actual_move_out_date?: string | null;
  status: string;
  request_note?: string | null;
  admin_note?: string | null;
};

const NGROK_SKIP_QUERY = "ngrok-skip-browser-warning=true";

const formatDateThai = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString("th-TH") : "-";

const statusLabel = (status?: string) => {
  if (status === "requested") return "รอตรวจสอบ";
  if (status === "approved") return "อนุมัติแล้ว";
  if (status === "rejected") return "ไม่อนุมัติ";
  if (status === "completed") return "เสร็จสิ้น";
  if (status === "cancelled") return "ยกเลิก";
  return status ?? "-";
};

export default function PaymentLiffMoveOutPage() {
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [request, setRequest] = useState<MoveOutRequest | null>(null);
  const [moveOutDate, setMoveOutDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [moveOutNote, setMoveOutNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

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
          setMessage("ไม่พบ NEXT_PUBLIC_PAYMENT_LIFF_ID");
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
        });

        const nextAccessToken = liff.getAccessToken() || "";
        setAccessToken(nextAccessToken);

        const response = await fetch("/api/payment-liff/move-out", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "true",
          },
          body: JSON.stringify({
            action: "get_status",
            accessToken: nextAccessToken,
          }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setMessage(data?.error ?? "โหลดข้อมูลคำขอย้ายออกไม่สำเร็จ");
          setLoading(false);
          return;
        }

        setTenant((data?.tenant ?? null) as TenantInfo | null);
        setRequest((data?.move_out_request ?? null) as MoveOutRequest | null);
        if (data?.move_out_request?.requested_move_out_date) {
          setMoveOutDate(String(data.move_out_request.requested_move_out_date));
          setMoveOutNote(String(data.move_out_request.request_note ?? ""));
        }
      } catch (error: any) {
        setMessage(error?.message ?? "เกิดข้อผิดพลาดในการเชื่อมต่อ LIFF");
      } finally {
        setLoading(false);
      }
    };

    void boot();
  }, []);

  const submitRequest = async () => {
    if (!accessToken) {
      setMessage("Session หมดอายุ กรุณาเข้าใหม่อีกครั้ง");
      return;
    }
    if (!moveOutDate) {
      setMessage("กรุณาเลือกวันที่ย้ายออก");
      return;
    }

    setSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/payment-liff/move-out", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true",
        },
        body: JSON.stringify({
          action: "create_request",
          accessToken,
          requestedMoveOutDate: moveOutDate,
          requestNote: moveOutNote,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error ?? "ส่งคำขอย้ายออกไม่สำเร็จ");
      }

      setRequest((data?.move_out_request ?? null) as MoveOutRequest | null);
      setMessage("ส่งคำขอย้ายออกเรียบร้อยแล้ว");
    } catch (error: any) {
      setMessage(error?.message ?? "ส่งคำขอย้ายออกไม่สำเร็จ");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-md space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">แจ้งย้ายออกผ่าน LINE</h1>
          <p className="mt-1 text-sm text-slate-500">
            ส่งวันที่ต้องการย้ายออกให้หอพักเพื่อตรวจสอบและสรุปยอดย้ายออก
          </p>
        </div>

        {profile && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-semibold text-slate-900">{profile.displayName}</p>
            {tenant && (
              <p className="mt-1 text-xs text-slate-500">
                {tenant.full_name} | ห้อง {tenant.room_number}
              </p>
            )}
          </div>
        )}

        {message && (
          <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{message}</div>
        )}

        {loading ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
            กำลังโหลดข้อมูล...
          </div>
        ) : (
          <>
            {request && (
              <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900">
                <p className="font-semibold">สถานะคำขอย้ายออก: {statusLabel(request.status)}</p>
                <p className="mt-1 text-xs">วันที่แจ้งย้ายออก: {formatDateThai(request.requested_move_out_date)}</p>
                {request.approved_move_out_date && (
                  <p className="mt-1 text-xs">วันที่อนุมัติ: {formatDateThai(request.approved_move_out_date)}</p>
                )}
                {request.admin_note && (
                  <p className="mt-1 text-xs">หมายเหตุจากหอพัก: {request.admin_note}</p>
                )}
              </div>
            )}

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div>
                <label className="text-sm font-medium text-slate-700">วันที่ต้องการย้ายออก</label>
                <input
                  type="date"
                  value={moveOutDate}
                  onChange={(event) => setMoveOutDate(event.target.value)}
                  className="mt-2 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div className="mt-3">
                <label className="text-sm font-medium text-slate-700">หมายเหตุเพิ่มเติม</label>
                <textarea
                  value={moveOutNote}
                  onChange={(event) => setMoveOutNote(event.target.value)}
                  rows={4}
                  className="mt-2 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  placeholder="เช่น ต้องการย้ายออกช่วงเช้า / ติดต่อกลับเบอร์..."
                />
              </div>

              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                กรุณาแจ้งย้ายออกล่วงหน้า และรอการยืนยันจากหอพักก่อนวันย้ายออกจริง
              </div>

              <button
                type="button"
                onClick={() => void submitRequest()}
                disabled={submitting}
                className="mt-4 w-full rounded-xl bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {submitting ? "กำลังส่งคำขอ..." : request ? "อัปเดตคำขอย้ายออก" : "ส่งคำขอย้ายออก"}
              </button>
            </div>

            <a
              href="/payment/liff"
              className="block rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-center text-sm font-semibold text-slate-700 shadow-sm"
            >
              กลับไปหน้าเมนูผู้เช่า
            </a>
          </>
        )}
      </div>
    </div>
  );
}
