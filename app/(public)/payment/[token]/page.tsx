"use client";

import { toast } from "sonner";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { isLateFeeBreakdownRow, isCarryForwardBreakdownRow, toChargeFeeRows } from "@/lib/invoice-utils";
import { CheckCircle2, Download, UploadCloud } from "lucide-react";

const NGROK_SKIP_QUERY = "ngrok-skip-browser-warning=true";

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
  late_fee_amount: number;
  payment_history: any[];
  rent_amount: number;
  water_bill: number;
  electricity_bill: number;
  common_fee: number;
  additional_fees_total: number;
  additional_fees_breakdown: any[];
  carry_forward_amount: number;
  discount_amount: number;
  discount_breakdown: any[];
  status: string;
  slip_url: string | null;
  tenant_name: string;
  tenant_move_in_date: string | null;
  custom_payment_method: any;
  room_number: string;
  room_price_month: number;
  late_fee_breakdown: Array<{
    id: string;
    source_invoice_id: string;
    snapshot_as_of: string;
    late_fee_amount: number;
    days_overdue: number;
    daily_rate: number;
    source_start_date?: string | null;
    /** Present only for rows sourced from the invoice's own current
     * breakdown — already a complete, up-to-date label (including the
     * accrual date range). Rendered as-is instead of reconstructed. */
    detail?: string;
  }>;
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

const formatMeterValue = (value: number | null | undefined) => {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return Number(Number(value).toFixed(2)).toString();
};

const formatUnitNumber = (value: number | null | undefined) => {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return Number(Number(value).toFixed(2)).toString();
};

const formatUnitInteger = (value: number | null | undefined) => {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return Math.round(Number(value)).toString();
};

const isTransferBreakdownRow = (row: any) =>
  String(row?.item_type ?? row?.type ?? "").toLowerCase() === "transfer_detail";

function normalizeInvoice(row: any): InvoiceData {
  const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
  const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;

  return {
    id: row.id,
    room_id: row.room_id,
    start_date: row.start_date,
    total_amount: Number(row.total_amount ?? 0),
    paid_amount: Number(row.paid_amount ?? 0),
    late_fee_amount: Number(row.late_fee_amount ?? 0),
    payment_history: Array.isArray(row.payment_history) ? row.payment_history : [],
    rent_amount: Number(row.rent_amount ?? 0),
    water_bill: Number(row.water_bill ?? 0),
    electricity_bill: Number(row.electricity_bill ?? 0),
    common_fee: Number(row.common_fee ?? 0),
    additional_fees_total: Number(row.additional_fees_total ?? 0),
    additional_fees_breakdown: Array.isArray(row.additional_fees_breakdown)
      ? row.additional_fees_breakdown
      : [],
    carry_forward_amount: Number(row.carry_forward_amount ?? 0),
    discount_amount: Number(row.discount_amount ?? 0),
    discount_breakdown: Array.isArray(row.discount_breakdown) ? row.discount_breakdown : [],
    status: row.status,
    slip_url: row.slip_url,
    tenant_move_in_date: tenant?.move_in_date ?? null,
    tenant_name: tenant?.full_name ?? "ผู้เช่า",
    custom_payment_method: tenant?.custom_payment_method ?? null,
    room_number: room?.room_number ?? "-",
    room_price_month: Number(room?.price_month ?? 0),
    late_fee_breakdown: Array.isArray(row.late_fee_breakdown) ? row.late_fee_breakdown : [],
  };
}

const toNumber = (value: string | number | null | undefined) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
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

// Moved server-side (finding C1) — this used to POST straight to Supabase
// Storage's REST endpoint with the anon key via a raw XHR (for progress
// events), bypassing even the Supabase JS client and any auth check. See
// app/api/payment-liff/upload-slip/route.ts.
function uploadSlipWithProgress(
  file: File,
  accessToken: string,
  onProgress: (percent: number) => void
) {
  return new Promise<{ url: string }>((resolve, reject) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("accessToken", accessToken);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/payment-liff/upload-slip", true);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };

    xhr.onload = () => {
      try {
        const parsed = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && parsed?.url) {
          resolve({ url: parsed.url });
          return;
        }
        reject(new Error(parsed?.error || "Upload failed."));
      } catch {
        reject(new Error(`Upload failed with status ${xhr.status}.`));
      }
    };

    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.send(formData);
  });
}

export default function PaymentTokenPage() {
  const params = useParams();
  const token = params?.token as string;

  const [invoice, setInvoice] = useState<InvoiceData | null>(null);
  const [defaultMethod, setDefaultMethod] = useState<PaymentMethod | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [billingDay, setBillingDay] = useState<number | null>(null);
  const [waterRate, setWaterRate] = useState(0);
  const [electricityRate, setElectricityRate] = useState(0);
  const [waterUnits, setWaterUnits] = useState<number | null>(null);
  const [electricityUnits, setElectricityUnits] = useState<number | null>(null);
  const [meterReading, setMeterReading] = useState<MeterReadingRow | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [liffReady, setLiffReady] = useState(false);
  const hasAuthorizedInvoiceRef = useRef(false);

  const [pointsBalance, setPointsBalance] = useState(0);
  const [coupons, setCoupons] = useState({ rent: { cost: 3000, value: 300 }, utility: { cost: 1500, value: 150 } });
  const [canRedeemThisInvoice, setCanRedeemThisInvoice] = useState(false);
  const [appliedCoupon, setAppliedCoupon] = useState<"rent" | "utility" | null>(null);
  const [redeemingTarget, setRedeemingTarget] = useState<"rent" | "utility" | null>(null);

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
        const liffId = process.env.NEXT_PUBLIC_PAYMENT_LIFF_ID;
        if (!liffId) {
          toast.error("ไม่พบ NEXT_PUBLIC_PAYMENT_LIFF_ID กรุณาตั้งค่าใน .env.local");
          setLiffReady(true);
          return;
        }

        await liff.init({ liffId });
        if (!liff.isLoggedIn()) {
          // Dynamic URLs cannot be registered as LINE login callbacks, causing a 400 Bad Request.
          // Redirect to the LIFF app endpoint where they can view all invoices and login properly.
          window.location.replace(`https://liff.line.me/${liffId}`);
          return;
        }

        setAccessToken(liff.getAccessToken() || "");
      } catch (error: any) {
        toast.error(error?.message ?? "เริ่มต้น LINE LIFF ไม่สำเร็จ");
      } finally {
        setLiffReady(true);
      }
    };

    void init();
  }, []);

  useEffect(() => {
    const load = async () => {
      if (!accessToken) {
        toast.error("กรุณาเข้าสู่ระบบ LINE ก่อนเปิดใบแจ้งหนี้");
        return;
      }

      if (!token) {
        toast.error("Missing token");
        return;
      }

      if (hasAuthorizedInvoiceRef.current) return;

      // One authorized call: verifies the LINE token against this invoice's
      // own tenant (or the admin allowlist), tracks the view, and returns
      // everything the page needs — payment method, settings, the invoice
      // itself, its meter reading, and its late-fee history. This used to be
      // one auth check followed by 5 separate direct-anon-key reads with no
      // ownership check of their own (finding C1,
      // docs/audit/2026-09-29-system-audit-detailed.md).
      const authRes = await fetch("/api/invoice-view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, accessToken }),
      }).catch(() => null);

      const authData = await authRes?.json().catch(() => ({} as any));

      if (!authRes || !authRes.ok) {
        toast.error(authData?.error ?? "ไม่สามารถเปิดใบแจ้งหนี้ได้");
        return;
      }

      hasAuthorizedInvoiceRef.current = true;

      const methodData = authData.defaultMethod;
      if (methodData) setDefaultMethod(methodData as PaymentMethod);

      const settingsData = authData.settingsRow;
      setBillingDay((settingsData as any)?.billing_day ?? null);
      const nextWaterRate = toNumber((settingsData as any)?.water_rate);
      const nextElectricityRate = toNumber((settingsData as any)?.electricity_rate);
      setWaterRate(nextWaterRate);
      setElectricityRate(nextElectricityRate);

      const data = authData.invoiceRow;
      if (!data) {
        toast.error("ไม่พบใบแจ้งหนี้");
        return;
      }

      const normalized = normalizeInvoice(data);

      // `invoice_arrears_snapshots` is a permanent audit log written once at
      // generation time — it is never updated or cleared when an admin later
      // edits or recalculates this invoice's carry-forward. Reading it
      // unconditionally showed a tenant a late fee their invoice no longer
      // actually bills (e.g. after an admin corrected a carried debt that had
      // meanwhile been paid off directly). The invoice's OWN current
      // breakdown is always checked first; the audit log is only a fallback
      // for a legacy invoice that predates itemized late-fee line items.
      const ownLateFeeRows = normalized.additional_fees_breakdown.filter(isLateFeeBreakdownRow);
      const arrearsRows = Array.isArray(authData.arrearsRows) ? authData.arrearsRows : [];
      normalized.late_fee_breakdown = ownLateFeeRows.length > 0
        ? ownLateFeeRows.map((row: any, index: number) => ({
            id: `own-${index}-${row.source_invoice_id ?? ""}`,
            source_invoice_id: String(row.source_invoice_id ?? ""),
            snapshot_as_of: String(row.snapshot_as_of ?? ""),
            late_fee_amount: toNumber(row.total_amount ?? row.amount),
            days_overdue: Math.round(toNumber(row.days_overdue ?? row.unit)),
            daily_rate: toNumber(row.daily_rate ?? row.price_per_unit),
            detail: String(row.detail ?? row.label ?? ""),
          }))
        : arrearsRows.map((row: any) => ({
            id: String(row.id),
            source_invoice_id: String(row.source_invoice_id),
            snapshot_as_of: String(row.snapshot_as_of),
            late_fee_amount: toNumber(row.late_fee_amount),
            days_overdue: Math.round(toNumber(row.days_overdue)),
            daily_rate: toNumber(row.daily_rate),
            source_start_date: typeof row.source_invoice === 'object' && row.source_invoice ? String((row.source_invoice as any).start_date) : null,
          }));
      setInvoice(normalized);
      setPreview(normalized.slip_url ?? null);

      const reading = (authData.meterReading as MeterReadingRow | null) ?? null;
      setMeterReading(reading);
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

    if (token && liffReady) void load();
  }, [token, accessToken, liffReady]);

  useEffect(() => {
    const loadPoints = async () => {
      if (!accessToken || !invoice?.id) return;
      if (!["pending", "overdue", "partial"].includes(invoice.status)) return;
      try {
        const response = await fetch("/api/payment-liff/points", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_balance", accessToken, invoiceId: invoice.id }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok) {
          setPointsBalance(data.balance ?? 0);
          if (data.coupons) setCoupons(data.coupons);
          setCanRedeemThisInvoice(!!data.canRedeemThisInvoice);
        }
      } catch {
        // Best-effort — the redeem section simply won't show if this fails.
      }
    };
    void loadPoints();
  }, [accessToken, invoice?.id, invoice?.status]);

  const handleRedeemCoupon = async (target: "rent" | "utility") => {
    if (!invoice || !accessToken) return;
    const points = coupons[target].cost;
    if (points > pointsBalance) {
      toast.error("คะแนนไม่เพียงพอ");
      return;
    }
    setRedeemingTarget(target);
    try {
      const response = await fetch("/api/payment-liff/points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "redeem",
          accessToken,
          invoiceId: invoice.id,
          target,
          pointsToRedeem: points,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error ?? "แลกคะแนนไม่สำเร็จ");

      toast.success(`ใช้คูปองสำเร็จ ได้รับส่วนลด ฿${formatBaht(data.bahtApplied ?? 0)}`);
      setAppliedCoupon(target);
      setCanRedeemThisInvoice(false);
      setInvoice((prev) =>
        prev
          ? {
              ...prev,
              total_amount: toNumber(data.updatedInvoice?.total_amount ?? prev.total_amount),
            }
          : prev
      );
      setPointsBalance(data.balance ?? 0);
    } catch (error: any) {
      toast.error(error?.message ?? "แลกคะแนนไม่สำเร็จ");
    } finally {
      setRedeemingTarget(null);
    }
  };

  const method: PaymentMethod | null = invoice?.custom_payment_method ?? defaultMethod ?? null;
  const transferBreakdownItems = (invoice?.additional_fees_breakdown ?? []).filter((row: any) =>
    isTransferBreakdownRow(row)
  );
  // Late-fee and carry-forward rows each get their own dedicated, clearly
  // labeled section below — excluded here so they don't also render a
  // second time in this generic "other fees" list. This used to only
  // exclude transfer/late-fee rows, so a carry-forward debt line showed up
  // looking like an ordinary fee with no explanation of what it was.
  const chargeBreakdownItems = toChargeFeeRows(invoice?.additional_fees_breakdown ?? []);
  const carryForwardItems = (invoice?.additional_fees_breakdown ?? []).filter(
    (row: any) => isCarryForwardBreakdownRow(row),
  );
  // additional_fees_total bundles the late-fee lines rendered separately
  // below; subtract them out so a bill with no OTHER fee doesn't show the
  // late fee a second time under this generic total.
  const lateFeeLineTotal = (invoice?.additional_fees_breakdown ?? [])
    .filter((row: any) => isLateFeeBreakdownRow(row))
    .reduce((sum: number, row: any) => sum + Number(row?.total_amount ?? row?.amount ?? 0), 0);
  const otherFeesTotal = Math.max(0, Number(invoice?.additional_fees_total ?? 0) - lateFeeLineTotal);
  const discountItems =
    Array.isArray(invoice?.discount_breakdown) && invoice!.discount_breakdown.length > 0
      ? invoice!.discount_breakdown
      : Number(invoice?.discount_amount ?? 0) > 0
        ? [{ detail: "ส่วนลด", total_amount: invoice!.discount_amount }]
        : [];
  const electricityPrevious =
    meterReading?.previous_electricity ?? meterReading?.previous_reading ?? null;
  const electricityCurrent =
    meterReading?.current_electricity ?? meterReading?.current_reading ?? null;
  const waterPrevious = meterReading?.previous_water ?? meterReading?.previous_reading ?? null;
  const waterCurrent = meterReading?.current_water ?? meterReading?.current_reading ?? null;
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
    try {
      const { url: publicUrl } = await uploadSlipWithProgress(file, accessToken, setUploadProgress);

      // Moved server-side (finding C1) — this used to write straight to
      // `invoices` from the browser with no ownership or status check at
      // all. /api/payment-liff/submit verifies the LINE token against this
      // invoice's own tenant, blocks submitting for an invoice already
      // carried into a newer one, writes the slip, and notifies the admin
      // itself (so no separate notify-slip-upload call is needed here).
      // allowResubmitWhileVerifying: true because this page has always let
      // a tenant replace a slip that's still under review.
      const response = await fetch("/api/payment-liff/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken,
          invoiceIds: [invoice.id],
          slipUrl: publicUrl,
          allowResubmitWhileVerifying: true,
        }),
      });
      const result = await response.json().catch(() => ({} as any));

      if (!response.ok) {
        toast.error(result?.error ?? "อัปโหลดสลิปไม่สำเร็จ");
        setUploading(false);
        return;
      }

      setInvoice((prev) =>
        prev
          ? {
              ...prev,
              status: "verifying",
              slip_url: publicUrl,
            }
          : prev
      );
      setPreview(publicUrl);
      setSubmitted(true);
      setUploading(false);
    } catch (uploadError: any) {
      toast.error(uploadError?.message ?? "อัปโหลดสลิปไม่สำเร็จ");
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
          <p className="text-sm text-slate-500">"กำลังโหลดใบแจ้งหนี้..."</p>
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
              <p className="text-sm text-slate-500">
                {invoice.status === "paid" ? "ใบเสร็จรับเงิน" : "ใบแจ้งหนี้"}
              </p>
              <h1 className="text-2xl font-semibold text-slate-900">ห้อง {invoice.room_number}</h1>
              <div className="mt-2">
                <Badge variant={invoice.status === "verifying" ? "info" : invoice.status === "paid" ? "success" : "warning"}>
                  สถานะ: {invoice.status === "verifying" ? "รอตรวจสอบ" : invoice.status === "paid" ? "ชำระแล้ว" : "รอชำระ"}
                </Badge>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">TOTAL</p>
              <p className="text-3xl font-semibold text-green-600">฿{formatBaht(toNumber(invoice.total_amount))}</p>
              <p className="mt-1 text-xs text-slate-500">ชำระแล้ว: ฿{formatBaht(invoice.paid_amount)}</p>
              <p className="text-xs text-rose-600">
                คงเหลือ: ฿{formatBaht(Math.max(0, toNumber(invoice.total_amount) - toNumber(invoice.paid_amount)))}
              </p>
            </div>
          </div>
          {invoice.status === "paid" && (
            <div className="mt-4">
              <a
                href={`/api/receipt/${token}`}
                className="inline-flex rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
              >
                ดาวน์โหลด PDF ใบเสร็จรับเงิน
              </a>
            </div>
          )}
          {invoice.status !== "paid" && (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              หากเกินกำหนดชำระอาจมีค่าปรับตามนโยบายหอพัก
            </div>
          )}
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
                <span className="block text-xs font-normal text-slate-500">
                  ({formatMeterValue(waterPrevious)} - {formatMeterValue(waterCurrent)} ={" "}
                  {formatUnitInteger(waterUnits)} หน่วย) x ฿
                  {formatUnitNumber(waterRate)}
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>ค่าไฟ</span>
              <span className="text-right font-semibold text-slate-900">
                <span className="block">฿{formatBaht(invoice.electricity_bill)}</span>
                <span className="block text-xs font-normal text-slate-500">
                  ({formatMeterValue(electricityPrevious)} - {formatMeterValue(electricityCurrent)} ={" "}
                  {formatUnitInteger(electricityUnits)} หน่วย) x ฿
                  {formatUnitNumber(electricityRate)}
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>ค่าส่วนกลาง</span>
              <span className="font-semibold text-slate-900">฿{formatBaht(invoice.common_fee)}</span>
            </div>
            {chargeBreakdownItems.length > 0 ? (
              chargeBreakdownItems.map((fee: any, idx: number) => (
                <div key={`${fee.label ?? fee.detail}-${idx}`} className="flex items-center justify-between">
                  <span>{fee.detail ?? fee.label ?? "ค่าธรรมเนียมเพิ่มเติม"}</span>
                  <span className="font-semibold text-slate-900">
                    ฿{formatBaht(Number(fee.total_amount ?? fee.amount ?? 0))}
                  </span>
                </div>
              ))
            ) : otherFeesTotal > 0 ? (
              <div className="flex items-center justify-between">
                <span>ค่าธรรมเนียมเพิ่มเติม</span>
                <span className="font-semibold text-slate-900">฿{formatBaht(otherFeesTotal)}</span>
              </div>
            ) : null}
            {carryForwardItems.length > 0 ? (
              carryForwardItems.map((fee: any, idx: number) => (
                <div
                  key={`carry-${fee.label ?? fee.detail}-${idx}`}
                  className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                >
                  <span>ยอดค้างยกมา - {fee.detail ?? fee.label ?? "-"}</span>
                  <span className="font-semibold">฿{formatBaht(Number(fee.total_amount ?? fee.amount ?? 0))}</span>
                </div>
              ))
            ) : invoice.carry_forward_amount > 0 ? (
              <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <span>ยอดค้างยกมา</span>
                <span className="font-semibold">฿{formatBaht(invoice.carry_forward_amount)}</span>
              </div>
            ) : null}
            {discountItems.map((fee: any, idx: number) => (
              <div key={`discount-${fee.label ?? fee.detail}-${idx}`} className="flex items-center justify-between text-emerald-700">
                <span>ส่วนลด{fee.detail && fee.detail !== "ส่วนลด" ? ` - ${fee.detail}` : ""}</span>
                <span className="font-semibold">-฿{formatBaht(Number(fee.total_amount ?? fee.amount ?? 0))}</span>
              </div>
            ))}
            {transferBreakdownItems.length > 0 && (
              <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-xs text-blue-900">
                <p className="font-semibold">สรุปย้ายห้องกลางเดือน</p>
                <div className="mt-2 space-y-1">
                  {transferBreakdownItems.map((item: any, idx: number) => (
                    <div key={`${item.label ?? item.detail}-${idx}`} className="flex items-start justify-between gap-3">
                      <span>{item.label ?? item.detail}</span>
                      <span className="text-right font-medium">{item.value ?? "-"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {invoice.late_fee_breakdown.length > 0 ? (
              invoice.late_fee_breakdown.map((row) => (
                <div
                  key={row.id}
                  className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                >
                  <span>
                    {row.detail ? (
                      row.detail
                    ) : (
                      <>
                        ค่าปรับล่าช้า - งวด {new Date(row.source_start_date ?? row.snapshot_as_of).toLocaleDateString("th-TH", { month: "long", year: "numeric" })}
                        <span className="block text-2xs font-normal text-amber-800">
                          {row.days_overdue.toLocaleString("th-TH")} วัน x ฿{formatBaht(row.daily_rate)}
                          /วัน
                        </span>
                      </>
                    )}
                  </span>
                  <span className="font-semibold">฿{formatBaht(row.late_fee_amount)}</span>
                </div>
              ))
            ) : invoice.late_fee_amount > 0 ? (
              <div className="flex items-center justify-between">
                <span>ค่าปรับล่าช้า</span>
                <span className="font-semibold text-slate-900">฿{formatBaht(invoice.late_fee_amount)}</span>
              </div>
            ) : null}
          </div>
        </section>

        {["pending", "overdue", "partial"].includes(invoice.status) && (
          <section className="rounded-3xl border border-white/60 bg-white/90 p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">คูปองแลกคะแนนสะสม</h2>
              <span className="text-sm font-semibold text-blue-700">
                {pointsBalance.toLocaleString("th-TH")} แต้มคงเหลือ
              </span>
            </div>

            {appliedCoupon ? (
              <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                ใช้คูปอง{appliedCoupon === "rent" ? "ส่วนลดค่าเช่า" : "ส่วนลดค่าน้ำ-ไฟ"}แล้ว — ยอดที่ต้องชำระด้านบนปรับส่วนลดให้แล้ว
              </div>
            ) : !canRedeemThisInvoice ? (
              <p className="mt-3 text-sm text-slate-500">ใช้สิทธิ์แลกคะแนนของเดือนนี้ไปแล้ว</p>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {(
                  [
                    { key: "rent" as const, label: "ส่วนลดค่าเช่า" },
                    { key: "utility" as const, label: "ส่วนลดค่าน้ำ-ไฟ" },
                  ]
                ).map(({ key, label }) => {
                  const coupon = coupons[key];
                  const affordable = pointsBalance >= coupon.cost;
                  const previewTotal = Math.max(0, toNumber(invoice.total_amount) - coupon.value);
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={!affordable || redeemingTarget !== null}
                      onClick={() => void handleRedeemCoupon(key)}
                      className={`relative flex flex-col rounded-2xl border-2 border-dashed p-4 text-left transition-colors ${
                        affordable
                          ? "border-blue-300 bg-blue-50 hover:bg-blue-100"
                          : "cursor-not-allowed border-slate-200 bg-slate-50 opacity-60"
                      }`}
                    >
                      <span className="text-xs font-semibold uppercase tracking-wide text-blue-700">{label}</span>
                      <span className="mt-1 text-2xl font-bold text-blue-900">-฿{formatBaht(coupon.value)}</span>
                      <span className="mt-1 text-xs text-slate-500">ใช้ {coupon.cost.toLocaleString("th-TH")} แต้ม</span>
                      {affordable ? (
                        <span className="mt-2 text-xs font-medium text-slate-600">
                          ยอดหลังใช้คูปอง ฿{formatBaht(previewTotal)}
                        </span>
                      ) : (
                        <span className="mt-2 text-xs font-medium text-rose-600">
                          ขาดอีก {(coupon.cost - pointsBalance).toLocaleString("th-TH")} แต้ม
                        </span>
                      )}
                      {redeemingTarget === key && (
                        <span className="mt-2 text-xs font-semibold text-blue-700">กำลังใช้คูปอง...</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}

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

        {invoice.status !== "paid" && (
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

              
            </div>
          </section>
        )}

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

