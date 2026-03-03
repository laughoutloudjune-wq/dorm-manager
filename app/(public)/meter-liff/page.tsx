"use client";

import { useEffect, useMemo, useState } from "react";

type LiffProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
};

type MeterRow = {
  room_id: string;
  room_number: string;
  building_name: string;
  reading_month: string;
  previous_electricity: number;
  current_electricity: number;
  electricity_usage: number;
  previous_water: number;
  current_water: number;
  water_usage: number;
};

const roomCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export default function MeterLiffPage() {
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [rows, setRows] = useState<MeterRow[]>([]);
  const [rates, setRates] = useState({ water_rate: 0, electricity_rate: 0 });
  const [loadingRows, setLoadingRows] = useState(false);
  const [saving, setSaving] = useState(false);

  const grouped = useMemo(() => {
    const map: Record<string, MeterRow[]> = {};
    for (const row of rows) {
      if (!map[row.building_name]) map[row.building_name] = [];
      map[row.building_name].push(row);
    }
    return Object.entries(map)
      .sort((a, b) => roomCompare(a[0], b[0]))
      .map(([building, buildingRows]) => ({
        building,
        rows: [...buildingRows].sort((a, b) => roomCompare(a.room_number, b.room_number)),
      }));
  }, [rows]);

  const postJson = async (url: string, payload: Record<string, unknown>) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error ?? "Request failed");
    return data;
  };

  const loadMeters = async () => {
    if (!accessToken) return;
    setLoadingRows(true);
    try {
      const data = await postJson("/api/admin-liff/meters", { accessToken, month });
      setRows((data?.rows ?? []) as MeterRow[]);
      setRates(data?.rates ?? { water_rate: 0, electricity_rate: 0 });
      setMessage(null);
    } catch (error: any) {
      setMessage(error?.message ?? "โหลดข้อมูลมิเตอร์ไม่สำเร็จ");
    } finally {
      setLoadingRows(false);
    }
  };

  const saveMeters = async () => {
    if (!accessToken || rows.length === 0) return;
    setSaving(true);
    try {
      await postJson("/api/admin-liff/meters/actions", {
        accessToken,
        action: "save_all",
        rows,
      });
      setMessage("บันทึกมิเตอร์สำเร็จ");
      await loadMeters();
    } catch (error: any) {
      setMessage(error?.message ?? "บันทึกมิเตอร์ไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  };

  const updateCurrent = (
    roomId: string,
    field: "current_electricity" | "current_water",
    nextValue: string
  ) => {
    const value = Number(nextValue || 0);
    setRows((prev) =>
      prev.map((row) => {
        if (row.room_id !== roomId) return row;
        const next = { ...row, [field]: Number.isFinite(value) ? value : 0 } as MeterRow;
        next.electricity_usage = Math.max(0, next.current_electricity - next.previous_electricity);
        next.water_usage = Math.max(0, next.current_water - next.previous_water);
        return next;
      })
    );
  };

  useEffect(() => {
    const boot = async () => {
      try {
        const { default: liff } = await import("@line/liff");
        const liffId = process.env.NEXT_PUBLIC_METER_LIFF_ID || process.env.NEXT_PUBLIC_ADMIN_LIFF_ID;
        if (!liffId) {
          throw new Error("Missing NEXT_PUBLIC_METER_LIFF_ID");
        }

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
    void loadMeters();
  }, [accessToken, month]);

  return (
    <div className="min-h-screen bg-slate-100 px-3 py-4">
      <div className="mx-auto w-full max-w-md space-y-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Apartment Flow - Meter LIFF</p>
          <h1 className="mt-1 text-lg font-semibold text-slate-900">บันทึกมิเตอร์ (พนักงาน)</h1>
          {profile && <p className="mt-2 text-sm text-slate-600">{profile.displayName}</p>}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <label className="mb-1 block text-xs font-medium text-slate-500">เดือนข้อมูล</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
          <p className="mt-2 text-xs text-slate-500">
            อัตราค่าน้ำ {rates.water_rate}/หน่วย | อัตราค่าไฟ {rates.electricity_rate}/หน่วย
          </p>
        </div>

        {message && (
          <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
            {message}
          </div>
        )}

        {loadingAuth ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
            กำลังเชื่อมต่อ LINE LIFF...
          </div>
        ) : loadingRows ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
            กำลังโหลดข้อมูลมิเตอร์...
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm font-semibold">
              ไฟฟ้า
            </div>
            {grouped.map((group) => (
              <div
                key={`electric-${group.building}`}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white"
              >
                <div className="bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600">
                  อาคาร {group.building}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-100">
                        <th className="px-2 py-1.5 text-left">ห้อง</th>
                        <th className="px-2 py-1.5 text-right">ก่อนหน้า</th>
                        <th className="px-2 py-1.5 text-right">ปัจจุบัน</th>
                        <th className="px-2 py-1.5 text-right">หน่วยใช้</th>
                        <th className="px-2 py-1.5 text-right">คำนวณ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row) => (
                        <tr key={`e-${row.room_id}`} className="border-t border-slate-100">
                          <td className="px-2 py-1.5">{row.room_number}</td>
                          <td className="px-2 py-1.5 text-right">{row.previous_electricity}</td>
                          <td className="px-2 py-1.5 text-right">
                            <input
                              type="number"
                              value={row.current_electricity}
                              onChange={(e) =>
                                updateCurrent(row.room_id, "current_electricity", e.target.value)
                              }
                              className="w-20 rounded border border-slate-300 px-1 py-0.5 text-right"
                            />
                          </td>
                          <td className="px-2 py-1.5 text-right font-semibold">
                            {row.electricity_usage}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            ({row.previous_electricity} - {row.current_electricity} ={" "}
                            {row.electricity_usage}) x {rates.electricity_rate}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm font-semibold">น้ำ</div>
            {grouped.map((group) => (
              <div
                key={`water-${group.building}`}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white"
              >
                <div className="bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600">
                  อาคาร {group.building}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-100">
                        <th className="px-2 py-1.5 text-left">ห้อง</th>
                        <th className="px-2 py-1.5 text-right">ก่อนหน้า</th>
                        <th className="px-2 py-1.5 text-right">ปัจจุบัน</th>
                        <th className="px-2 py-1.5 text-right">หน่วยใช้</th>
                        <th className="px-2 py-1.5 text-right">คำนวณ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row) => (
                        <tr key={`w-${row.room_id}`} className="border-t border-slate-100">
                          <td className="px-2 py-1.5">{row.room_number}</td>
                          <td className="px-2 py-1.5 text-right">{row.previous_water}</td>
                          <td className="px-2 py-1.5 text-right">
                            <input
                              type="number"
                              value={row.current_water}
                              onChange={(e) => updateCurrent(row.room_id, "current_water", e.target.value)}
                              className="w-20 rounded border border-slate-300 px-1 py-0.5 text-right"
                            />
                          </td>
                          <td className="px-2 py-1.5 text-right font-semibold">{row.water_usage}</td>
                          <td className="px-2 py-1.5 text-right">
                            ({row.previous_water} - {row.current_water} = {row.water_usage}) x{" "}
                            {rates.water_rate}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={() => void saveMeters()}
              disabled={saving}
              className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {saving ? "กำลังบันทึก..." : "บันทึกมิเตอร์ทั้งหมด"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

