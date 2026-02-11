"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-client";

type LiffProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
};

type RoomSuggestion = {
  id: string;
  room_number: string;
  building_name?: string | null;
};

const NGROK_SKIP_QUERY = "ngrok-skip-browser-warning=true";

const roomNumberCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export default function RegisterPage() {
  const supabase = useMemo(() => createClient(), []);
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [roomNumber, setRoomNumber] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [newTenantSlipUrl, setNewTenantSlipUrl] = useState("");
  const [suggestions, setSuggestions] = useState<RoomSuggestion[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [uploadingNewTenantSlip, setUploadingNewTenantSlip] = useState(false);

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
        const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
        if (!liffId) {
          setStatus("ไม่พบ LIFF ID กรุณาตั้งค่า NEXT_PUBLIC_LIFF_ID ใน .env.local");
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
        setLoading(false);
      } catch (error: any) {
        setStatus(error?.message ?? "เริ่มต้น LINE LIFF ไม่สำเร็จ");
        setLoading(false);
      }
    };

    void init();
  }, []);

  useEffect(() => {
    const keyword = roomNumber.trim();
    const controller = new AbortController();

    const loadSuggestions = async () => {
      if (!keyword) {
        setSuggestions([]);
        return;
      }

      setSuggestLoading(true);
      try {
        const response = await fetch(
          `/api/register/available-rooms?query=${encodeURIComponent(keyword)}`,
          {
            headers: { "ngrok-skip-browser-warning": "true" },
            signal: controller.signal,
          }
        );
        const data = await response.json();
        if (!response.ok) {
          setSuggestions([]);
          return;
        }

        const next = ((data.rooms ?? []) as RoomSuggestion[]).sort((a, b) => {
          const byBuilding = (a.building_name ?? "").localeCompare(b.building_name ?? "", undefined, {
            numeric: true,
            sensitivity: "base",
          });
          if (byBuilding !== 0) return byBuilding;
          return roomNumberCompare(a.room_number, b.room_number);
        });

        setSuggestions(next);
      } catch {
        setSuggestions([]);
      } finally {
        setSuggestLoading(false);
      }
    };

    const timer = setTimeout(() => {
      void loadSuggestions();
    }, 200);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [roomNumber]);

  const uploadSlip = async (file: File | null | undefined) => {
    if (!file) return;
    const safeRoom = roomNumber.trim() || "unknown-room";
    const filename = `${Date.now()}-${file.name}`;
    const path = `tenant-docs/register/${safeRoom}/new-tenant-${filename}`;

    setUploadingNewTenantSlip(true);

    try {
      const { error: uploadError } = await supabase.storage
        .from("tenant-docs")
        .upload(path, file, { upsert: true });

      if (uploadError) {
        setStatus(uploadError.message);
        return;
      }

      const { data } = supabase.storage.from("tenant-docs").getPublicUrl(path);
      setNewTenantSlipUrl(data.publicUrl);
      setStatus("อัปโหลดสลิปสำเร็จ");
    } finally {
      setUploadingNewTenantSlip(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile) return;

    setSubmitting(true);
    setStatus(null);
    const { default: liff } = await import("@line/liff");
    const accessToken = liff.getAccessToken();

    const response = await fetch("/api/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({
        roomNumber: roomNumber.trim(),
        fullName: `${firstName.trim()} ${lastName.trim()}`.replace(/\s+/g, " ").trim(),
        phoneNumber: phoneNumber.trim(),
        userId: profile.userId,
        accessToken,
        depositSlipUrl: newTenantSlipUrl || null,
        advanceRentSlipUrl: newTenantSlipUrl || null,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      setStatus(data?.error ?? "ลงทะเบียนไม่สำเร็จ");
    } else {
      setStatus("ลงทะเบียนสำเร็จ สามารถปิดหน้านี้ได้");
    }
    setSubmitting(false);
  };

  const showSuggestions = useMemo(() => roomNumber.trim().length > 0, [roomNumber]);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-12">
      <div className="mx-auto w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-xl">
        <h1 className="text-2xl font-semibold text-slate-900">ลงทะเบียนบัญชี LINE</h1>
        <p className="mt-2 text-sm text-slate-500">
          เชื่อมบัญชี LINE กับห้องพักเพื่อรับใบแจ้งหนี้อัตโนมัติ
        </p>

        {loading ? (
          <p className="mt-6 text-sm text-slate-500">กำลังเริ่มต้นระบบ LINE Login...</p>
        ) : profile ? (
          <div className="mt-6 space-y-4">
            <div className="flex items-center gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-3">
              {profile.pictureUrl && (
                <img
                  src={profile.pictureUrl}
                  alt={profile.displayName}
                  className="h-12 w-12 rounded-full"
                />
              )}
              <div>
                <p className="text-sm font-semibold text-slate-900">{profile.displayName}</p>
                <p className="text-xs text-slate-500">เชื่อมต่อ LINE แล้ว</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <label className="block text-sm text-slate-600">
                เลขห้อง
                <input
                  value={roomNumber}
                  onChange={(event) => setRoomNumber(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
                  required
                  placeholder="เช่น 101"
                />
              </label>

              {showSuggestions && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-2">
                  <p className="px-2 py-1 text-xs text-slate-500">
                    {suggestLoading ? "กำลังค้นหาห้องว่าง..." : "ห้องว่างที่ตรงกับข้อมูล"}
                  </p>
                  <div className="max-h-44 space-y-1 overflow-auto">
                    {suggestions.map((room) => (
                      <button
                        key={room.id}
                        type="button"
                        onClick={() => {
                          setRoomNumber(room.room_number);
                          setSuggestions([]);
                        }}
                        className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-white"
                      >
                        {room.room_number}
                        {room.building_name ? ` (${room.building_name})` : ""}
                      </button>
                    ))}
                    {!suggestLoading && suggestions.length === 0 && (
                      <p className="px-3 py-2 text-xs text-slate-500">ไม่พบห้องว่างที่ตรงกับเลขห้องที่พิมพ์</p>
                    )}
                  </div>
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block text-sm text-slate-600">
                  ชื่อผู้เช่า
                  <input
                    value={firstName}
                    onChange={(event) => setFirstName(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
                    required
                    placeholder="กรอกชื่อ"
                  />
                </label>
                <label className="block text-sm text-slate-600">
                  นามสกุลผู้เช่า
                  <input
                    value={lastName}
                    onChange={(event) => setLastName(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
                    required
                    placeholder="กรอกนามสกุล"
                  />
                </label>
              </div>

              <label className="block text-sm text-slate-600">
                เบอร์โทรศัพท์
                <input
                  value={phoneNumber}
                  onChange={(event) => setPhoneNumber(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
                  required
                  placeholder="เช่น 08xxxxxxxx"
                />
              </label>

              <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-semibold text-slate-700">สำหรับผู้เช่าใหม่เท่านั้น</p>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="inline-flex cursor-pointer items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700">
                    {uploadingNewTenantSlip ? "กำลังอัปโหลด..." : "อัปโหลดสลิปเงินประกัน/ค่าเช่าล่วงหน้า"}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(event) => void uploadSlip(event.target.files?.[0])}
                      disabled={uploadingNewTenantSlip}
                    />
                  </label>
                  {newTenantSlipUrl && (
                    <a className="text-xs text-blue-600 underline" href={newTenantSlipUrl} target="_blank" rel="noreferrer">
                      ดูสลิป
                    </a>
                  )}
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
              >
                {submitting ? "กำลังลงทะเบียน..." : "ยืนยันการลงทะเบียน"}
              </button>
            </form>
          </div>
        ) : (
          <p className="mt-6 text-sm text-red-600">{status ?? "ไม่สามารถโหลดโปรไฟล์ LINE ได้"}</p>
        )}

        {status && profile && (
          <p className="mt-4 rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-600">{status}</p>
        )}

        <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          กรุณาใส่ชื่อ-นามสกุลเต็มของผู้เช่าเพื่อความถูกต้องในการออกใบแจ้งหนี้และใบเสร็จ
        </p>
      </div>
    </div>
  );
}
