"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

type LiffProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
};

const NGROK_SKIP_QUERY = "ngrok-skip-browser-warning=true";

export default function MeterStaffRegisterPage() {
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [staffNote, setStaffNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    const init = async () => {
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
        const liffId = process.env.NEXT_PUBLIC_METER_STAFF_REGISTER_LIFF_ID;
        if (!liffId) {
          toast.error("ไม่พบ NEXT_PUBLIC_METER_STAFF_REGISTER_LIFF_ID ใน .env");
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
        setAccessToken(liff.getAccessToken() || "");
        setLoading(false);
      } catch (error: any) {
        toast.error(error?.message ?? "เริ่มต้น LINE LIFF ไม่สำเร็จ");
        setLoading(false);
      }
    };

    void init();
  }, []);

  const handleRegister = async () => {
    if (!accessToken) {
      toast.error("Session หมดอายุ กรุณาเข้าใหม่อีกครั้ง");
      return;
    }

    setSubmitting(true);


    try {
      const response = await fetch("/api/meter-staff/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true",
        },
        body: JSON.stringify({ accessToken, staffNote: staffNote.trim() || null }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error ?? "ลงทะเบียนไม่สำเร็จ");
      }
      setRegistered(true);
      toast.success(data?.message ?? "ลงทะเบียนสำเร็จ");
    } catch (error: any) {
      toast.error(error?.message ?? "ลงทะเบียนไม่สำเร็จ");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-xl">
        <h1 className="text-2xl font-semibold text-slate-900">ลงทะเบียนพนักงานมิเตอร์</h1>
        <p className="mt-2 text-sm text-slate-500">
          ระบบจะบันทึก LINE User ID ของคุณอัตโนมัติ — ไม่ต้องให้แอดมินคัดลอกไปใส่ใน Environment อีกต่อไป
        </p>

        {loading ? (
          <p className="mt-6 text-sm text-slate-500">กำลังเชื่อมต่อ LINE...</p>
        ) : profile ? (
          <div className="mt-6 space-y-4">
            <div className="flex items-center gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-3">
              {profile.pictureUrl ? (
                <img
                  src={profile.pictureUrl}
                  alt={profile.displayName}
                  className="h-12 w-12 rounded-full"
                />
              ) : null}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">{profile.displayName}</p>
                <p className="mt-1 break-all text-xs text-slate-500">LINE ID: {profile.userId}</p>
              </div>
            </div>

            <label className="block text-sm text-slate-600">
              ชื่อเล่น / หมายเหตุ (ไม่บังคับ)
              <input
                value={staffNote}
                onChange={(event) => setStaffNote(event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm"
                placeholder="เช่น ชั้น A / น้องเอ"
              />
            </label>

            <button
              type="button"
              disabled={submitting || registered}
              onClick={() => void handleRegister()}
              className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:bg-slate-300"
            >
              {submitting ? "กำลังบันทึก..." : registered ? "ลงทะเบียนแล้ว" : "ยืนยันลงทะเบียน"}
            </button>

            {registered && (
              <a
                href="/meter-liff"
                className="block w-full rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-center text-sm font-semibold text-blue-700"
              >
                ไปหน้าบันทึกมิเตอร์
              </a>
            )}
          </div>
        ) : (
          <p className="mt-6 text-sm text-red-600">ไม่สามารถเชื่อมต่อ LINE ได้</p>
        )}


      </div>
    </div>
  );
}
