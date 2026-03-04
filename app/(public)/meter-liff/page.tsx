"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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

type UtilityMode = "electricity" | "water";

const roomCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const floorFromRoom = (roomNumber: string) => {
  const digits = String(roomNumber ?? "").replace(/\D/g, "");
  if (!digits) return "-";
  if (digits.length <= 2) return digits[0] ?? "-";
  return digits.slice(0, -2);
};

const toNumber = (value: string | number | null | undefined) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export default function MeterLiffPage() {
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [rows, setRows] = useState<MeterRow[]>([]);
  const [draftInputs, setDraftInputs] = useState<Record<string, string>>({});
  const [rates, setRates] = useState({ water_rate: 0, electricity_rate: 0 });
  const [loadingRows, setLoadingRows] = useState(false);
  const [saving, setSaving] = useState(false);

  const [mode, setMode] = useState<UtilityMode>("electricity");
  const [buildingFilter, setBuildingFilter] = useState("all");
  const [floorFilter, setFloorFilter] = useState("all");

  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

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
      const nextRows = (data?.rows ?? []) as MeterRow[];
      setRows(nextRows);
      setRates(data?.rates ?? { water_rate: 0, electricity_rate: 0 });
      setDraftInputs(() => {
        const next: Record<string, string> = {};
        for (const row of nextRows) {
          next[`${row.room_id}:electricity`] =
            row.current_electricity === 0 ? "" : String(row.current_electricity);
          next[`${row.room_id}:water`] = row.current_water === 0 ? "" : String(row.current_water);
        }
        return next;
      });
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

  useEffect(() => {
    const boot = async () => {
      try {
        const { default: liff } = await import("@line/liff");
        const liffId = process.env.NEXT_PUBLIC_METER_LIFF_ID || process.env.NEXT_PUBLIC_ADMIN_LIFF_ID;
        if (!liffId) throw new Error("Missing NEXT_PUBLIC_METER_LIFF_ID");

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

  const buildingOptions = useMemo(() => {
    const set = new Set(rows.map((row) => row.building_name));
    return [...set].sort(roomCompare);
  }, [rows]);

  const floorOptions = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) {
      if (buildingFilter !== "all" && row.building_name !== buildingFilter) continue;
      set.add(floorFromRoom(row.room_number));
    }
    return [...set].sort(roomCompare);
  }, [rows, buildingFilter]);

  const visibleRows = useMemo(() => {
    const filtered = rows.filter((row) => {
      if (buildingFilter !== "all" && row.building_name !== buildingFilter) return false;
      if (floorFilter !== "all" && floorFromRoom(row.room_number) !== floorFilter) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      const byBuilding = a.building_name.localeCompare(b.building_name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      if (byBuilding !== 0) return byBuilding;
      return roomCompare(a.room_number, b.room_number);
    });
  }, [rows, buildingFilter, floorFilter]);

  const groupedVisibleRows = useMemo(() => {
    const map: Record<string, MeterRow[]> = {};
    for (const row of visibleRows) {
      if (!map[row.building_name]) map[row.building_name] = [];
      map[row.building_name].push(row);
    }
    return Object.entries(map).sort((a, b) => roomCompare(a[0], b[0]));
  }, [visibleRows]);

  const orderedRoomIds = useMemo(() => visibleRows.map((row) => row.room_id), [visibleRows]);

  const setCurrentValue = (roomId: string, utilityMode: UtilityMode, inputValue: string) => {
    const key = `${roomId}:${utilityMode}`;
    setDraftInputs((prev) => ({ ...prev, [key]: inputValue }));
    if (inputValue.trim() === "") return;

    const value = toNumber(inputValue);
    setRows((prev) =>
      prev.map((row) => {
        if (row.room_id !== roomId) return row;
        const next = { ...row };
        if (utilityMode === "electricity") {
          next.current_electricity = value;
          next.electricity_usage = next.current_electricity - next.previous_electricity;
        } else {
          next.current_water = value;
          next.water_usage = next.current_water - next.previous_water;
        }
        return next;
      })
    );
  };

  const commitIfEmpty = (roomId: string, utilityMode: UtilityMode) => {
    const key = `${roomId}:${utilityMode}`;
    if ((draftInputs[key] ?? "").trim() !== "") return;
    setRows((prev) =>
      prev.map((row) => {
        if (row.room_id !== roomId) return row;
        const next = { ...row };
        if (utilityMode === "electricity") {
          next.current_electricity = 0;
          next.electricity_usage = next.current_electricity - next.previous_electricity;
        } else {
          next.current_water = 0;
          next.water_usage = next.current_water - next.previous_water;
        }
        return next;
      })
    );
  };

  const focusNext = (roomId: string) => {
    const idx = orderedRoomIds.indexOf(roomId);
    if (idx < 0) return;
    const nextId = orderedRoomIds[idx + 1];
    if (!nextId) return;
    inputRefs.current[`${nextId}:${mode}`]?.focus();
  };

  const usageValue = (row: MeterRow) => (mode === "electricity" ? row.electricity_usage : row.water_usage);
  const previousValue = (row: MeterRow) =>
    mode === "electricity" ? row.previous_electricity : row.previous_water;
  const currentValue = (row: MeterRow) => (mode === "electricity" ? row.current_electricity : row.current_water);
  const currentDraftValue = (row: MeterRow) => {
    const key = `${row.room_id}:${mode}`;
    const draft = draftInputs[key];
    if (draft != null) return draft;
    const current = currentValue(row);
    return current === 0 ? "" : String(current);
  };

  const usageColorClass = (usage: number) =>
    usage < 0 ? "text-rose-600" : usage > 0 ? "text-emerald-600" : "text-slate-700";

  const modeTheme = mode === "electricity"
    ? {
        tabActive: "bg-amber-500 text-white",
        panel: "border-amber-200",
        heading: "text-amber-700",
      }
    : {
        tabActive: "bg-sky-500 text-white",
        panel: "border-sky-200",
        heading: "text-sky-700",
      };

  return (
    <div className="min-h-screen bg-slate-100 px-3 py-4">
      <div className="mx-auto w-full max-w-md space-y-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Apartment Flow - Meter LIFF</p>
          <h1 className="mt-1 text-lg font-semibold text-slate-900">บันทึกมิเตอร์</h1>
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
        </div>

        <div className={`rounded-2xl border bg-white p-3 shadow-sm ${modeTheme.panel}`}>
          <p className={`mb-2 text-xs font-semibold ${modeTheme.heading}`}>1) เลือกประเภทมิเตอร์</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMode("electricity")}
              className={`rounded-xl px-3 py-2 text-sm font-semibold ${
                mode === "electricity" ? "bg-amber-500 text-white" : "bg-slate-100 text-slate-700"
              }`}
            >
              ไฟฟ้า
            </button>
            <button
              type="button"
              onClick={() => setMode("water")}
              className={`rounded-xl px-3 py-2 text-sm font-semibold ${
                mode === "water" ? "bg-sky-500 text-white" : "bg-slate-100 text-slate-700"
              }`}
            >
              น้ำ
            </button>
          </div>
        </div>

        <div className={`rounded-2xl border bg-white p-3 shadow-sm ${modeTheme.panel}`}>
          <p className={`mb-2 text-xs font-semibold ${modeTheme.heading}`}>2) เลือกอาคารและชั้น</p>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={buildingFilter}
              onChange={(e) => {
                setBuildingFilter(e.target.value);
                setFloorFilter("all");
              }}
              className="rounded-xl border border-slate-300 px-2 py-2 text-sm"
            >
              <option value="all">ทุกอาคาร</option>
              {buildingOptions.map((building) => (
                <option key={building} value={building}>
                  {building}
                </option>
              ))}
            </select>
            <select
              value={floorFilter}
              onChange={(e) => setFloorFilter(e.target.value)}
              className="rounded-xl border border-slate-300 px-2 py-2 text-sm"
            >
              <option value="all">ทุกชั้น</option>
              {floorOptions.map((floor) => (
                <option key={floor} value={floor}>
                  ชั้น {floor}
                </option>
              ))}
            </select>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            อัตรา {mode === "electricity" ? "ค่าไฟ" : "ค่าน้ำ"}{" "}
            {mode === "electricity" ? rates.electricity_rate : rates.water_rate}/หน่วย
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
            {groupedVisibleRows.length === 0 ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
                ไม่พบข้อมูลห้องตามตัวกรองที่เลือก
              </div>
            ) : (
              groupedVisibleRows.map(([buildingName, buildingRows]) => (
                <div
                  key={`${mode}:${buildingName}`}
                  className={`overflow-hidden rounded-xl border bg-white ${modeTheme.panel}`}
                >
                  <div className="bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">
                    อาคาร {buildingName}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-slate-100">
                          <th className="px-2 py-1.5 text-left">ห้อง</th>
                          <th className="px-2 py-1.5 text-right">ก่อนหน้า</th>
                          <th className="px-2 py-1.5 text-right">ปัจจุบัน</th>
                          <th className="px-2 py-1.5 text-right">หน่วยใช้</th>
                        </tr>
                      </thead>
                      <tbody>
                        {buildingRows.map((row) => (
                          <tr key={`${mode}:${row.room_id}`} className="border-t border-slate-100">
                            <td className="px-2 py-1.5">{row.room_number}</td>
                            <td className="px-2 py-1.5 text-right">{previousValue(row)}</td>
                            <td className="px-2 py-1.5 text-right">
                              <input
                                ref={(element) => {
                                  inputRefs.current[`${row.room_id}:${mode}`] = element;
                                }}
                                type="text"
                                inputMode="numeric"
                                enterKeyHint="next"
                                pattern="[0-9]*"
                                value={currentDraftValue(row)}
                                placeholder="-"
                                onChange={(e) => setCurrentValue(row.room_id, mode, e.target.value)}
                                onBlur={() => commitIfEmpty(row.room_id, mode)}
                                onKeyDown={(e) => {
                                  if (e.key !== "Enter") return;
                                  e.preventDefault();
                                  commitIfEmpty(row.room_id, mode);
                                  focusNext(row.room_id);
                                }}
                                className="w-20 rounded border border-slate-300 px-1 py-0.5 text-right"
                              />
                            </td>
                            <td className={`px-2 py-1.5 text-right font-semibold ${usageColorClass(usageValue(row))}`}>
                              {usageValue(row)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}

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

