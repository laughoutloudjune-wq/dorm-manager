"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { createClient } from "@/lib/supabase-client";
import { CheckCircle2, Download, UploadCloud } from "lucide-react";

type PaymentMethod = {
  label?: string;
  bank_name?: string;
  account_name?: string;
  account_number?: string;
  qr_url?: string | null;
};

type InvoiceData = {
  id: string;
  room_id: string;
  start_date: string;
  total_amount: number;
  paid_amount: number;
  payment_history: any[];
  rent_amount: number;
  water_bill: number;
  electricity_bill: number;
  common_fee: number;
  additional_fees_total: number;
  additional_fees_breakdown: any[];
  status: string;
  slip_url: string | null;
  tenant_name: string;
  tenant_move_in_date: string | null;
  custom_payment_method: any;
  room_number: string;
  room_price_month: number;
};

type MeterReadingRow = {
  electricity_usage?: number | null;
  water_usage?: number | null;
  usage?: number | null;
  previous_electricity?: number | null;
  current_electricity?: number | null;
  previous_water?: number | null;
  current_water?: number | null;
  previous_reading?: number | null;
  current_reading?: number | null;
};

const formatBaht = (value: number) =>
  Number(value || 0).toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function normalizeInvoice(row: any): InvoiceData {
  const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
  const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;

  return {
    id: row.id,
    room_id: row.room_id,
    start_date: row.start_date,
    total_amount: Number(row.total_amount ?? 0),
    paid_amount: Number(row.paid_amount ?? 0),
    payment_history: Array.isArray(row.payment_history) ? row.payment_history : [],
    rent_amount: Number(row.rent_amount ?? 0),
    water_bill: Number(row.water_bill ?? 0),
    electricity_bill: Number(row.electricity_bill ?? 0),
    common_fee: Number(row.common_fee ?? 0),
    additional_fees_total: Number(row.additional_fees_total ?? 0),
    additional_fees_breakdown: Array.isArray(row.additional_fees_breakdown)
      ? row.additional_fees_breakdown
      : [],
    status: row.status,
    slip_url: row.slip_url,
    tenant_move_in_date: tenant?.move_in_date ?? null,
    tenant_name: tenant?.full_name ?? "ผู้เช่า",
    custom_payment_method: tenant?.custom_payment_method ?? null,
    room_number: room?.room_number ?? "-",
    room_price_month: Number(room?.price_month ?? 0),
  };
}

const toNumber = (value: string | number | null | undefined) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const monthStartFromDate = (dateString: string) => {
  const date = new Date(dateString);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
};

const resolveElectricityUsage = (reading: MeterReadingRow | null | undefined) => {
  if (!reading) return null;
  if (reading.electricity_usage != null) return toNumber(reading.electricity_usage);
  if (reading.current_electricity != null && reading.previous_electricity != null) {
    return toNumber(reading.current_electricity) - toNumber(reading.previous_electricity);
  }
  return null;
};

const resolveWaterUsage = (reading: MeterReadingRow | null | undefined) => {
  if (!reading) return null;
  if (reading.water_usage != null) return toNumber(reading.water_usage);
  if (reading.usage != null) return toNumber(reading.usage);
  if (reading.current_water != null && reading.previous_water != null) {
    return toNumber(reading.current_water) - toNumber(reading.previous_water);
  }
  if (reading.current_reading != null && reading.previous_reading != null) {
    return toNumber(reading.current_reading) - toNumber(reading.previous_reading);
  }
  return null;
};

const calculateProratePreview = (
  monthlyRent: number,
  moveInDateText: string | null | undefined,
  billingDayInput: number | null | undefined
) => {
  if (!moveInDateText || !monthlyRent) return null;
  const moveInDay = Math.min(Math.max(Number(moveInDateText.split("-")[2] ?? 1), 1), 30);
  const billingDay = Math.min(Math.max(Number(billingDayInput ?? 1), 1), 30);
  const dailyRaw = monthlyRent / 30;
  const dailyRounded = Math.floor(dailyRaw);
  const occupiedDays =
    moveInDay <= billingDay
      ? billingDay - moveInDay + 1
      : (30 - moveInDay + 1) + billingDay;
  const rentAmount = dailyRounded * occupiedDays;
  return { dailyRaw, dailyRounded, occupiedDays, moveInDay, billingDay, rentAmount };
};

function uploadToSupabaseWithProgress(
  file: File,
  bucket: string,
  filePath: string,
  onProgress: (percent: number) => void
) {
  return new Promise<{ path: string }>((resolve, reject) => {
    const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!baseUrl || !anonKey) {
      reject(new Error("Supabase environment is missing."));
      return;
    }

    const encodedPath = filePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const url = `${baseUrl}/storage/v1/object/${bucket}/${encodedPath}`;

    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("apikey", anonKey);
    xhr.setRequestHeader("Authorization", `Bearer ${anonKey}`);
    xhr.setRequestHeader("x-upsert", "true");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      onProgress(percent);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ path: filePath });
        return;
      }
      try {
        const parsed = JSON.parse(xhr.responseText);
        reject(new Error(parsed?.message || "Upload failed."));
      } catch {
        reject(new Error(`Upload failed with status ${xhr.status}.`));
      }
    };

    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.send(file);
  });
}

export default function PaymentTokenPage() {
  const params = useParams();
  const token = params?.token as string;
  const supabase = useMemo(() => createClient(), []);

  const [invoice, setInvoice] = useState<InvoiceData | null>(null);
  const [defaultMethod, setDefaultMethod] = useState<PaymentMethod | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [billingDay, setBillingDay] = useState<number | null>(null);
  const [waterRate, setWaterRate] = useState(0);
  const [electricityRate, setElectricityRate] = useState(0);
  const [waterUnits, setWaterUnits] = useState<number | null>(null);
  const [electricityUnits, setElectricityUnits] = useState<number | null>(null);

  useEffect(() => {
    const load = async () => {
      const { data: methodData } = await supabase
        .from("payment_methods")
        .select("label,bank_name,account_name,account_number,qr_url")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (methodData) setDefaultMethod(methodData as PaymentMethod);

      const { data: settingsData } = await supabase
        .from("settings")
        .select("billing_day,water_rate,electricity_rate")
        .eq("id", 1)
        .maybeSingle();
      setBillingDay((settingsData as any)?.billing_day ?? null);
      const nextWaterRate = toNumber((settingsData as any)?.water_rate);
      const nextElectricityRate = toNumber((settingsData as any)?.electricity_rate);
      setWaterRate(nextWaterRate);
      setElectricityRate(nextElectricityRate);

      const { data, error: fetchError } = await supabase
        .from("invoices")
        .select(
          "id,room_id,start_date,total_amount,paid_amount,payment_history,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total,additional_fees_breakdown,status,slip_url,tenants(full_name,custom_payment_method,move_in_date),rooms(room_number,price_month)"
        )
        .eq("public_token", token)
        .single();

      if (fetchError || !data) {
        setError("ไม่พบใบแจ้งหนี้");
        return;
      }

      const normalized = normalizeInvoice(data);
      setInvoice(normalized);
      setPreview(normalized.slip_url ?? null);

      const readingMonth = monthStartFromDate(normalized.start_date);
      const { data: readingData } = await supabase
        .from("meter_readings")
        .select(
          "electricity_usage,water_usage,usage,previous_electricity,current_electricity,previous_water,current_water,previous_reading,current_reading"
        )
        .eq("room_id", normalized.room_id)
        .eq("reading_month", readingMonth)
        .maybeSingle();

      const reading = (readingData as MeterReadingRow | null) ?? null;
      let nextWaterUnits = resolveWaterUsage(reading);
      let nextElectricityUnits = resolveElectricityUsage(reading);

      if (nextWaterUnits == null && nextWaterRate > 0) {
        nextWaterUnits = toNumber(normalized.water_bill) / nextWaterRate;
      }
      if (nextElectricityUnits == null && nextElectricityRate > 0) {
        nextElectricityUnits = toNumber(normalized.electricity_bill) / nextElectricityRate;
      }

      setWaterUnits(nextWaterUnits);
      setElectricityUnits(nextElectricityUnits);
    };

    if (token) void load();
  }, [token, supabase]);

  const method: PaymentMethod | null = invoice?.custom_payment_method ?? defaultMethod ?? null;
  const proratePreview =
    invoice && billingDay
      ? calculateProratePreview(invoice.room_price_month, invoice.tenant_move_in_date, billingDay)
      : null;
  const isProratedRent =
    !!invoice &&
    !!proratePreview &&
    Math.abs(Number(invoice.rent_amount ?? 0) - Number(proratePreview.rentAmount ?? 0)) < 0.01;

  const handleUpload = async (file?: File | null) => {
    if (!invoice || !file) return;

    setUploading(true);
    setUploadProgress(0);
    setError(null);

    try {
      const bucket = "payment_slips";
      const filePath = `${invoice.id}/${Date.now()}-${file.name}`;

      await uploadToSupabaseWithProgress(file, bucket, filePath, setUploadProgress);

      const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
      const publicUrl = data.publicUrl;

      const { error: updateError } = await supabase
        .from("invoices")
        .update({
          slip_url: publicUrl,
          slip_uploaded_at: new Date().toISOString(),
          status: "verifying",
        })
        .eq("id", invoice.id);

      if (updateError) {
        setError(updateError.message);
        setUploading(false);
        return;
      }

      setPreview(publicUrl);
      setSubmitted(true);
      setUploading(false);
    } catch (uploadError: any) {
      setError(uploadError?.message ?? "อัปโหลดสลิปไม่สำเร็จ");
      setUploading(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen px-4 py-10">
        <div className="mx-auto max-w-md rounded-3xl border border-white/60 bg-white/90 p-6 text-center shadow-xl">
          <CheckCircle2 className="mx-auto h-12 w-12 text-green-600" />
          <h1 className="mt-4 text-2xl font-semibold text-slate-900">รับข้อมูลการชำระเงินแล้ว</h1>
          <p className="mt-2 text-sm text-slate-500">ระบบกำลังรอตรวจสอบสลิปของคุณ</p>
          <Badge variant="info" className="mt-4">
            สถานะ: รอตรวจสอบ
          </Badge>
        </div>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="min-h-screen px-4 py-10">
        <div className="mx-auto max-w-md rounded-3xl border border-white/60 bg-white/90 p-6 text-center shadow-xl">
          <p className="text-sm text-slate-500">{error ?? "กำลังโหลดใบแจ้งหนี้..."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-10">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <header className="rounded-3xl border border-white/60 bg-white/90 p-6 shadow-xl">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">ใบแจ้งหนี้</p>
              <h1 className="text-2xl font-semibold text-slate-900">ห้อง {invoice.room_number}</h1>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">TOTAL</p>
              <p className="text-3xl font-semibold text-green-600">฿{formatBaht(invoice.total_amount)}</p>
              <p className="mt-1 text-xs text-slate-500">ชำระแล้ว: ฿{formatBaht(invoice.paid_amount)}</p>
              <p className="text-xs text-rose-600">
                คงเหลือ: ฿{formatBaht(Math.max(0, toNumber(invoice.total_amount) - toNumber(invoice.paid_amount)))}
              </p>
            </div>
          </div>
        </header>

        <section className="rounded-3xl border border-white/60 bg-white/90 p-6 shadow-xl">
          <h2 className="text-lg font-semibold text-slate-900">รายละเอียดค่าใช้จ่าย</h2>
          <div className="mt-4 space-y-3 text-sm text-slate-600">
            <div className="flex items-center justify-between">
              <span>ค่าเช่า</span>
              <span className="font-semibold text-slate-900">฿{formatBaht(invoice.rent_amount)}</span>
            </div>
            {isProratedRent && proratePreview && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                Pro-rate formula: ฿{formatBaht(invoice.room_price_month)} / 30 ={" "}
                {proratePreview.dailyRaw.toFixed(2)} then use ฿{proratePreview.dailyRounded}/day x{" "}
                {proratePreview.occupiedDays} day(s) = ฿{formatBaht(proratePreview.rentAmount)}
              </div>
            )}
            <div className="flex items-center justify-between">
              <span>ค่าน้ำ</span>
              <span className="text-right font-semibold text-slate-900">
                <span className="block">฿{formatBaht(invoice.water_bill)}</span>
                {waterUnits != null && waterRate > 0 && (
                  <span className="block text-xs font-normal text-slate-500">
                    {waterUnits.toFixed(2)} unit x ฿{formatBaht(waterRate)}
                  </span>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>ค่าไฟ</span>
              <span className="text-right font-semibold text-slate-900">
                <span className="block">฿{formatBaht(invoice.electricity_bill)}</span>
                {electricityUnits != null && electricityRate > 0 && (
                  <span className="block text-xs font-normal text-slate-500">
                    {electricityUnits.toFixed(2)} unit x ฿{formatBaht(electricityRate)}
                  </span>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>ค่าส่วนกลาง</span>
              <span className="font-semibold text-slate-900">฿{formatBaht(invoice.common_fee)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>ค่าธรรมเนียมเพิ่มเติม</span>
              <span className="font-semibold text-slate-900">
                ฿{formatBaht(invoice.additional_fees_total)}
              </span>
            </div>
            {invoice.additional_fees_breakdown.map((fee: any, idx: number) => (
              <div key={`${fee.label ?? fee.detail}-${idx}`} className="flex items-center justify-between text-xs">
                <span>{fee.detail ?? fee.label}</span>
                <span>฿{formatBaht(Number(fee.total_amount ?? fee.amount ?? 0))}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-white/60 bg-white/90 p-6 shadow-xl">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">ช่องทางชำระเงิน</h2>
            <Badge variant="success">{invoice.custom_payment_method ? "เฉพาะห้อง" : "ค่าเริ่มต้น"}</Badge>
          </div>
          {method ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 text-sm text-slate-600">
                <p className="font-semibold text-slate-900">{method.label ?? "การชำระเงิน"}</p>
                {method.bank_name && <p>ธนาคาร: {method.bank_name}</p>}
                {method.account_name && <p>ชื่อบัญชี: {method.account_name}</p>}
                {method.account_number && <p>เลขบัญชี: {method.account_number}</p>}
              </div>
              {method.qr_url && (
                <div className="flex flex-col items-center gap-3">
                  <img
                    src={method.qr_url}
                    alt="Payment QR"
                    className="h-40 w-40 rounded-2xl border border-slate-200 object-cover"
                  />
                  <a
                    href={method.qr_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600"
                  >
                    <Download size={14} />
                    เปิดรูป QR
                  </a>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">ยังไม่ได้ตั้งค่าช่องทางชำระเงิน</p>
          )}
        </section>

        <section className="rounded-3xl border border-white/60 bg-white/90 p-6 shadow-xl">
          <h2 className="text-lg font-semibold text-slate-900">อัปโหลดสลิปการโอน</h2>
          <div className="mt-4 space-y-4">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
              <UploadCloud size={24} />
              <span>{uploading ? `กำลังอัปโหลด... ${uploadProgress}%` : "แตะเพื่อเลือกไฟล์สลิป"}</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={uploading}
                onChange={(event) => handleUpload(event.target.files?.[0])}
              />
            </label>

            {uploading && (
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-2 rounded-full bg-blue-600 transition-all duration-200"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-slate-500">กำลังอัปโหลดสลิป {uploadProgress}%</p>
              </div>
            )}

            {preview && (
              <div className="rounded-2xl border border-slate-200 bg-white p-3">
                <p className="text-xs text-slate-400">ตัวอย่างสลิป</p>
                <img src={preview} alt="Payment slip preview" className="mt-2 w-full rounded-xl" />
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {error}
              </div>
            )}
          </div>
        </section>

        <section className="rounded-3xl border border-white/60 bg-white/90 p-6 shadow-xl">
          <h2 className="text-lg font-semibold text-slate-900">ประวัติการชำระเงิน</h2>
          {invoice.payment_history.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">ยังไม่มีประวัติการชำระเงิน</p>
          ) : (
            <div className="mt-3 space-y-2">
              {invoice.payment_history.map((item: any, idx: number) => (
                <div
                  key={`${item.paid_at ?? item.created_at ?? idx}-${idx}`}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700"
                >
                  <p className="font-semibold text-slate-900">฿{formatBaht(toNumber(item.amount))}</p>
                  <p className="text-xs text-slate-500">
                    {item.mode === "full" ? "Full" : "Partial"} |{" "}
                    {item.paid_at ? new Date(item.paid_at).toLocaleString("th-TH") : "-"}
                  </p>
                  {item.slip_url && (
                    <a
                      href={item.slip_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex text-xs text-blue-600 underline"
                    >
                      ดูสลิป
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

