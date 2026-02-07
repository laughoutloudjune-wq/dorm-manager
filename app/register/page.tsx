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
  building_name?: string;
};

const NGROK_SKIP_QUERY = "ngrok-skip-browser-warning=true";

export default function RegisterPage() {
  const supabase = useMemo(() => createClient(), []);
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [roomNumber, setRoomNumber] = useState("");
  const [fullName, setFullName] = useState("");
  const [suggestions, setSuggestions] = useState<RoomSuggestion[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

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
    const loadSuggestions = async () => {
      const keyword = roomNumber.trim();
      if (keyword.length < 1) {
        setSuggestions([]);
        return;
      }

      const { data, error } = await supabase
        .from("rooms")
        .select("id,room_number,buildings(name)")
        .eq("status", "available")
        .ilike("room_number", `${keyword}%`)
        .order("room_number", { ascending: true })
        .limit(8);

      if (error) return;

      const rows = (data ?? []).map((row: any) => {
        const building = Array.isArray(row.buildings) ? row.buildings[0] : row.buildings;
        return {
          id: row.id,
          room_number: row.room_number,
          building_name: building?.name,
        };
      });

      setSuggestions(rows);
    };

    void loadSuggestions();
  }, [roomNumber, supabase]);

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
        fullName: fullName.trim(),
        userId: profile.userId,
        accessToken,
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
                  list="room-number-suggestion"
                  placeholder="เช่น 101"
                />
                <datalist id="room-number-suggestion">
                  {suggestions.map((room) => (
                    <option key={room.id} value={room.room_number}>
                      {room.building_name
                        ? `${room.room_number} (${room.building_name})`
                        : room.room_number}
                    </option>
                  ))}
                </datalist>
              </label>

              {suggestions.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                  พบเลขห้องในระบบ: {suggestions.map((item) => item.room_number).join(", ")}
                </div>
              )}

              <label className="block text-sm text-slate-600">
                ชื่อ-นามสกุลผู้เช่า
                <input
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
                  required
                  placeholder="กรอกชื่อ-นามสกุลเต็ม"
                />
              </label>

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
