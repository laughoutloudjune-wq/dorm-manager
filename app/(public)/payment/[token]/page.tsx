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
  total_amount: number;
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
    total_amount: Number(row.total_amount ?? 0),
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
    tenant_name: tenant?.full_name ?? "เธเธนเนเน€เธเนเธฒ",
    custom_payment_method: tenant?.custom_payment_method ?? null,
    room_number: room?.room_number ?? "-",
    room_price_month: Number(room?.price_month ?? 0),
  };
}

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
        .select("billing_day")
        .eq("id", 1)
        .maybeSingle();
      setBillingDay((settingsData as any)?.billing_day ?? null);

      const { data, error: fetchError } = await supabase
        .from("invoices")
        .select(
          "id,total_amount,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total,additional_fees_breakdown,status,slip_url,tenants(full_name,custom_payment_method,move_in_date),rooms(room_number,price_month)"
        )
        .eq("public_token", token)
        .single();

      if (fetchError || !data) {
        setError("เนเธกเนเธเธเนเธเนเธเนเธเธซเธเธตเน");
        return;
      }

      const normalized = normalizeInvoice(data);
      setInvoice(normalized);
      setPreview(normalized.slip_url ?? null);
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
      setError(uploadError?.message ?? "เธญเธฑเธเนเธซเธฅเธ”เธชเธฅเธดเธเนเธกเนเธชเธณเน€เธฃเนเธ");
      setUploading(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen px-4 py-10">
        <div className="mx-auto max-w-md rounded-3xl border border-white/60 bg-white/90 p-6 text-center shadow-xl">
          <CheckCircle2 className="mx-auto h-12 w-12 text-green-600" />
          <h1 className="mt-4 text-2xl font-semibold text-slate-900">เธฃเธฑเธเธเนเธญเธกเธนเธฅเธเธฒเธฃเธเธณเธฃเธฐเน€เธเธดเธเนเธฅเนเธง</h1>
          <p className="mt-2 text-sm text-slate-500">เธฃเธฐเธเธเธเธณเธฅเธฑเธเธฃเธญเธ•เธฃเธงเธเธชเธญเธเธชเธฅเธดเธเธเธญเธเธเธธเธ“</p>
          <Badge variant="info" className="mt-4">
            เธชเธ–เธฒเธเธฐ: เธฃเธญเธ•เธฃเธงเธเธชเธญเธ
          </Badge>
        </div>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="min-h-screen px-4 py-10">
        <div className="mx-auto max-w-md rounded-3xl border border-white/60 bg-white/90 p-6 text-center shadow-xl">
          <p className="text-sm text-slate-500">{error ?? "เธเธณเธฅเธฑเธเนเธซเธฅเธ”เนเธเนเธเนเธเธซเธเธตเน..."}</p>
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
              <p className="text-sm text-slate-500">เนเธเนเธเนเธเธซเธเธตเน</p>
              <h1 className="text-2xl font-semibold text-slate-900">เธซเนเธญเธ {invoice.room_number}</h1>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">TOTAL</p>
              <p className="text-3xl font-semibold text-green-600">เธฟ{formatBaht(invoice.total_amount)}</p>
            </div>
          </div>
        </header>

        <section className="rounded-3xl border border-white/60 bg-white/90 p-6 shadow-xl">
          <h2 className="text-lg font-semibold text-slate-900">เธฃเธฒเธขเธฅเธฐเน€เธญเธตเธขเธ”เธเนเธฒเนเธเนเธเนเธฒเธข</h2>
          <div className="mt-4 space-y-3 text-sm text-slate-600">
            <div className="flex items-center justify-between">
              <span>เธเนเธฒเน€เธเนเธฒ</span>
              <span className="font-semibold text-slate-900">เธฟ{formatBaht(invoice.rent_amount)}</span>
            </div>
            {isProratedRent && proratePreview && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                Pro-rate formula: ฿{formatBaht(invoice.room_price_month)} / 30 ={" "}
                {proratePreview.dailyRaw.toFixed(2)} then use ฿{proratePreview.dailyRounded}/day x{" "}
                {proratePreview.occupiedDays} day(s) = ฿{formatBaht(proratePreview.rentAmount)}
              </div>
            )}
            <div className="flex items-center justify-between">
              <span>เธเนเธฒเธเนเธณ</span>
              <span className="font-semibold text-slate-900">เธฟ{formatBaht(invoice.water_bill)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>เธเนเธฒเนเธ</span>
              <span className="font-semibold text-slate-900">เธฟ{formatBaht(invoice.electricity_bill)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>เธเนเธฒเธชเนเธงเธเธเธฅเธฒเธ</span>
              <span className="font-semibold text-slate-900">เธฟ{formatBaht(invoice.common_fee)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>เธเนเธฒเธเธฃเธฃเธกเน€เธเธตเธขเธกเน€เธเธดเนเธกเน€เธ•เธดเธก</span>
              <span className="font-semibold text-slate-900">
                เธฟ{formatBaht(invoice.additional_fees_total)}
              </span>
            </div>
            {invoice.additional_fees_breakdown.map((fee: any, idx: number) => (
              <div key={`${fee.label ?? fee.detail}-${idx}`} className="flex items-center justify-between text-xs">
                <span>{fee.detail ?? fee.label}</span>
                <span>เธฟ{formatBaht(Number(fee.total_amount ?? fee.amount ?? 0))}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-white/60 bg-white/90 p-6 shadow-xl">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">เธเนเธญเธเธ—เธฒเธเธเธณเธฃเธฐเน€เธเธดเธ</h2>
            <Badge variant="success">{invoice.custom_payment_method ? "เน€เธเธเธฒเธฐเธซเนเธญเธ" : "เธเนเธฒเน€เธฃเธดเนเธกเธ•เนเธ"}</Badge>
          </div>
          {method ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 text-sm text-slate-600">
                <p className="font-semibold text-slate-900">{method.label ?? "เธเธฒเธฃเธเธณเธฃเธฐเน€เธเธดเธ"}</p>
                {method.bank_name && <p>เธเธเธฒเธเธฒเธฃ: {method.bank_name}</p>}
                {method.account_name && <p>เธเธทเนเธญเธเธฑเธเธเธต: {method.account_name}</p>}
                {method.account_number && <p>เน€เธฅเธเธเธฑเธเธเธต: {method.account_number}</p>}
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
                    เน€เธเธดเธ”เธฃเธนเธ QR
                  </a>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">เธขเธฑเธเนเธกเนเนเธ”เนเธ•เธฑเนเธเธเนเธฒเธเนเธญเธเธ—เธฒเธเธเธณเธฃเธฐเน€เธเธดเธ</p>
          )}
        </section>

        <section className="rounded-3xl border border-white/60 bg-white/90 p-6 shadow-xl">
          <h2 className="text-lg font-semibold text-slate-900">เธญเธฑเธเนเธซเธฅเธ”เธชเธฅเธดเธเธเธฒเธฃเนเธญเธ</h2>
          <div className="mt-4 space-y-4">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
              <UploadCloud size={24} />
              <span>{uploading ? `เธเธณเธฅเธฑเธเธญเธฑเธเนเธซเธฅเธ”... ${uploadProgress}%` : "เนเธ•เธฐเน€เธเธทเนเธญเน€เธฅเธทเธญเธเนเธเธฅเนเธชเธฅเธดเธ"}</span>
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
                <p className="mt-2 text-xs text-slate-500">เธเธณเธฅเธฑเธเธญเธฑเธเนเธซเธฅเธ”เธชเธฅเธดเธ {uploadProgress}%</p>
              </div>
            )}

            {preview && (
              <div className="rounded-2xl border border-slate-200 bg-white p-3">
                <p className="text-xs text-slate-400">เธ•เธฑเธงเธญเธขเนเธฒเธเธชเธฅเธดเธ</p>
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
      </div>
    </div>
  );
}

