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
const POLICY_VERSION = "v1.0";
const APARTMENT_POLICY = [
  {
    title: "คำนำ",
    items: [
      "ผู้เช่าตกลงที่จะปฏิบัติตามกฎระเบียบของหอพักดังต่อไปนี้อย่างเคร่งครัด หากฝ่าฝืนยินยอมให้ผู้ให้เช่าดำเนินการปรับหรือบอกเลิกสัญญาเช่าได้ทันที",
    ],
  },
  {
    title: "1. การชำระเงินและการสิ้นสุดสัญญา",
    items: [
      "1.1 หากผู้เช่าชำระค่าเช่าช้ากว่ากำหนด ผู้เช่าจะต้องเสียค่าปรับในความล่าช้าให้แก่ผู้ให้เช่าในอัตรา 100 บาทต่อวัน หากชำระเกินกำหนด ผู้ให้เช่ามีสิทธิตัดน้ำ ตัดไฟ หรือยกเลิกสัญญาโดยทันที",
      "1.2 หากประสงค์จะยกเลิกสัญญาหรือย้ายออก จะต้องแจ้งเป็นลายลักษณ์อักษร หรือแจ้งผ่านระบบ/ไลน์ (LINE) ของหอพัก ล่วงหน้าไม่น้อยกว่า 30 วัน ก่อนวันย้ายออก และต้องย้ายออกภายในสิ้นเดือนนั้นๆ หากอยู่เกิน ผู้ให้เช่ามีสิทธิ์คิดค่าเช่าเต็มเดือนเป็นค่าขาดผลประโยชน์",
      "1.3 กรณีอยู่ไม่ครบสัญญา (แต่อยู่เกินกึ่งหนึ่งของสัญญาและต้องคืนเงินประกัน) ผู้ให้เช่าสามารถเรียกร้องค่าขาดผลประโยชน์ในเดือนที่เหลือได้ เป็นจำนวนเงินเดือนละ 3,000 บาท หรือไม่เกินจำนวนของเงินประกัน",
      "1.4 ในวันย้ายออก ถ้าหากผู้เช่าอยู่ไม่ครบตามระยะสัญญา ผู้เช่าจะไม่สามารถนำเงินประกันห้องพักมาหักค่าน้ำและค่าไฟฟ้าได้ ผู้เช่าจะต้องทำการชำระค่าน้ำและค่าไฟฟ้าให้ครบถ้วนก่อนจึงจะสามารถย้ายออกได้",
    ],
  },
  {
    title: "2. การปรับแต่งและรักษาสภาพห้องพัก",
    items: [
      "2.1 ผู้เช่าจะไม่ทำการดัดแปลง ต่อเติม รื้อถอน หรือเคลื่อนย้ายทรัพย์สินในห้องเช่าออกนอกห้องเช่า หากฝ่าฝืนต้องรับผิดชอบชดใช้ความเสียหายที่เกิดขึ้น",
      "2.2 ห้ามติดสติ๊กเกอร์ / ตัวแขวน / ราวผ้า / รูปภาพ ตามผนัง ฝ้า และห้ามเจาะผนังโดยเด็ดขาด หากฝ่าฝืนปรับจุดละ 50 บาท",
    ],
  },
  {
    title: "3. การรักษาความสะอาดและระบบท่อน้ำ",
    items: [
      "3.1 ห้ามวางขยะหรือกวาดขยะออกมานอกห้องเช่าโดยเด็ดขาด",
      "3.2 ห้ามทิ้งผ้าอนามัย / ขยะ / เศษอาหาร ลงในชักโครก / ท่อน้ำ / และซิงค์ล้างจาน หากท่อตันคิดค่าบริการครั้งละ 800 บาท หรือตามที่ช่างประเมินหน้างาน",
    ],
  },
  {
    title: "4. ความสงบเรียบร้อยและข้อห้ามเด็ดขาด",
    items: [
      "4.1 ห้ามส่งเสียงดังยามวิกาล / ห้ามตำน้ำพริกยามวิกาล (22.00 น. - 06.00 น.)",
      "4.2 ห้ามผู้เช่าสูบบุหรี่ภายในห้องเช่า ฝ่าฝืนปรับ 2,000 บาท",
      "4.3 ผู้เช่าจะไม่เลี้ยงสัตว์ทุกชนิดในห้องเช่า และจะไม่นำสิ่งเสพติดหรือสิ่งผิดกฎหมายใดๆ เข้ามาในห้องเช่า หากฝ่าฝืน ผู้เช่ายอมให้ผู้ให้เช่าบอกเลิกสัญญาได้ทันที",
    ],
  },
  {
    title: "5. การจัดการทั่วไปและความปลอดภัย",
    items: [
      "5.1 การยืมกุญแจ: กรณีผู้เช่าลืมกุญแจห้องเช่า คิดค่ายืมกุญแจครั้งละ 50 บาท มัดจำ 100 บาท (หากกุญแจหายคิดค่าเปลี่ยนลูกบิดใหม่ 400 บาท) ยืมได้ในเวลา 09.00 - 18.00 น. เท่านั้น และจะต้องได้รับอนุญาตจากเจ้าของสัญญาก่อนทุกครั้ง",
      "5.2 เวลาขนย้าย: การขนย้ายสิ่งของเข้า/ออก ห้องเช่า ต้องทำในเวลา 09.00 - 18.00 น. เท่านั้น หากจำเป็นต้องขนย้ายนอกเวลา จะต้องแจ้งและได้รับอนุญาตจากหอพักก่อนทุกครั้ง",
      "5.3 ผู้เช่ายินยอมให้ผู้ให้เช่าหรือผู้ที่ได้รับมอบหมายเข้ามาในห้องเช่า เพื่อตรวจดูสภาพห้องได้ทุกเวลา หากผู้เช่ากระทำการใดๆ อันผิดต่อสัญญาเช่า ผู้ให้เช่ามีสิทธิบอกเลิกสัญญาเช่าได้ทันที โดยไม่ต้องบอกกล่าวก่อน",
      "5.4 ถ้าหากเกิดอัคคีภัย สัญญาฉบับนี้จะสิ้นสุดทันที โดยผู้เช่าจะไม่เรียกร้องค่าเสียหายใดๆ ทั้งสิ้น",
    ],
  },
] as const;

const roomNumberCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export default function RegisterPage() {
  const supabase = useMemo(() => createClient(), []);
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [roomNumber, setRoomNumber] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [isNewTenant, setIsNewTenant] = useState(false);
  const [moveInDate, setMoveInDate] = useState(new Date().toISOString().slice(0, 10));
  const [newTenantSlipUrl, setNewTenantSlipUrl] = useState("");
  const [suggestions, setSuggestions] = useState<RoomSuggestion[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [uploadingNewTenantSlip, setUploadingNewTenantSlip] = useState(false);
  const [showSuccessOverlay, setShowSuccessOverlay] = useState(false);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [policyModalOpen, setPolicyModalOpen] = useState(false);

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

    if (isNewTenant && !newTenantSlipUrl) {
      setStatus("กรุณาอัปโหลดสลิปเงินประกันหรือค่าเช่าล่วงหน้าก่อนลงทะเบียน");
      return;
    }

    if (isNewTenant && !policyAccepted) {
      setStatus("กรุณาอ่านและยอมรับกฎระเบียบหอพักก่อนลงทะเบียน");
      return;
    }

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
        isNewTenant,
        moveInDate: isNewTenant ? moveInDate : null,
        depositSlipUrl: isNewTenant ? newTenantSlipUrl || null : null,
        advanceRentSlipUrl: isNewTenant ? newTenantSlipUrl || null : null,
        policyAccepted: isNewTenant ? policyAccepted : false,
        policyAcceptedAt: isNewTenant && policyAccepted ? new Date().toISOString() : null,
        policyVersion: isNewTenant ? POLICY_VERSION : null,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      setStatus(data?.error ?? "ลงทะเบียนไม่สำเร็จ");
    } else {
      setStatus("ลงทะเบียนสำเร็จ");
      setShowSuccessOverlay(true);
      setRoomNumber("");
      setFirstName("");
      setLastName("");
      setPhoneNumber("");
      setSuggestions([]);
      setIsNewTenant(false);
      setMoveInDate(new Date().toISOString().slice(0, 10));
      setNewTenantSlipUrl("");
      setPolicyAccepted(false);
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
                    {suggestLoading ? "กำลังค้นหาห้อง..." : "ห้องที่ตรงกับข้อมูล"}
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
                      <p className="px-3 py-2 text-xs text-slate-500">ไม่พบห้องที่ลงทะเบียนได้ตามเลขห้องที่พิมพ์</p>
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
                  onChange={(event) =>
                    setPhoneNumber(event.target.value.replace(/\D/g, "").slice(0, 15))
                  }
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
                  required
                  placeholder="เช่น 08xxxxxxxx"
                />
              </label>

              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={isNewTenant}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setIsNewTenant(checked);
                    if (!checked) {
                      setNewTenantSlipUrl("");
                      setPolicyAccepted(false);
                      setPolicyModalOpen(false);
                    }
                  }}
                  className="h-4 w-4 rounded border-slate-300"
                />
                ผู้เช่าใหม่
              </label>

              {isNewTenant && (
                <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <label className="block text-sm text-slate-600">
                    วันที่ย้ายเข้า
                    <input
                      type="date"
                      value={moveInDate}
                      onChange={(event) => setMoveInDate(event.target.value)}
                      className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
                      required={isNewTenant}
                    />
                  </label>
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
                  <div className="space-y-3 rounded-2xl border border-slate-300 bg-white p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">ข้อตกลงและกฎระเบียบหอพัก</p>
                        <p className="text-xs text-slate-500">กดเพื่ออ่านฉบับเต็มก่อนยอมรับข้อตกลง</p>
                      </div>
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-600">
                        {POLICY_VERSION}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPolicyModalOpen(true)}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left text-sm text-slate-700 transition hover:border-blue-200 hover:bg-blue-50"
                    >
                      <span className="block font-medium text-slate-900">
                        เปิดอ่านกฎระเบียบหอพักฉบับเต็ม
                      </span>
                      <span className="mt-1 block text-xs text-slate-500">
                        กรุณาอ่านรายละเอียดทั้งหมดก่อนกดยอมรับ
                      </span>
                    </button>
                    <label
                      className={`flex items-start gap-3 rounded-xl border px-3 py-3 text-sm ${
                        policyAccepted
                          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                          : "border-slate-200 bg-slate-50 text-slate-700"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={policyAccepted}
                        readOnly
                        className="mt-0.5 h-4 w-4 rounded border-slate-300"
                      />
                      <span>
                        {policyAccepted
                          ? "ข้าพเจ้าได้อ่าน เข้าใจ และยอมรับกฎระเบียบหอพักแล้ว"
                          : "ยังไม่ได้ยอมรับกฎระเบียบหอพัก กรุณาเปิดอ่านฉบับเต็มก่อน"}
                      </span>
                    </label>
                  </div>
                </div>
              )}

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
      {showSuccessOverlay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 px-6">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl">
            <p className="text-lg font-semibold text-emerald-700">ลงทะเบียนสำเร็จ</p>
            <p className="mt-2 text-sm text-slate-600">
              บันทึกข้อมูลเรียบร้อยแล้ว สามารถปิดหน้านี้ได้
            </p>
            <button
              type="button"
              onClick={() => setShowSuccessOverlay(false)}
              className="mt-5 w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white"
            >
              รับทราบ
            </button>
          </div>
        </div>
      )}
      {policyModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80">
          <div className="flex h-full flex-col bg-white">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 md:px-6">
              <div>
                <p className="text-lg font-semibold text-slate-900">
                  เอกสารแนบท้ายสัญญาเช่า: กฎระเบียบและข้อตกลงการอยู่ร่วมพักอาศัย
                </p>
                <p className="mt-1 text-sm text-slate-500">กรุณาอ่านรายละเอียดทั้งหมดก่อนกดยอมรับ</p>
              </div>
              <button
                type="button"
                onClick={() => setPolicyModalOpen(false)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600"
              >
                ปิด
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-5 md:px-6">
              <div className="mx-auto max-w-3xl space-y-5 text-sm leading-7 text-slate-700">
                {APARTMENT_POLICY.map((section) => (
                  <div key={section.title} className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="font-semibold text-slate-900">{section.title}</p>
                    <div className="space-y-2">
                      {section.items.map((item) => (
                        <p key={item}>{item}</p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="border-t border-slate-200 bg-white px-4 py-4 md:px-6">
              <div className="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setPolicyModalOpen(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700"
                >
                  ยังไม่ยอมรับ
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPolicyAccepted(true);
                    setPolicyModalOpen(false);
                    setStatus(null);
                  }}
                  className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white"
                >
                  อ่านแล้วและยอมรับ
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
