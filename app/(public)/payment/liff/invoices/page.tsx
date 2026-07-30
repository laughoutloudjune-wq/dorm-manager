"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";

type TenantInfo = {
  id: string;
  full_name: string;
  room_number: string;
  policy_accepted?: boolean;
};

type InvoiceRow = {
  id: string;
  public_token: string;
  issue_date: string;
  due_date: string;
  total_amount: number;
  paid_amount?: number;
  status?: string;
  late_fee_amount?: number;
};

const NGROK_SKIP_QUERY = "ngrok-skip-browser-warning=true";

const formatMoney = (value: number) =>
  Number(value || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const outstandingAmount = (invoice: InvoiceRow) =>
  Math.max(0, Number(invoice.total_amount ?? 0) - Number(invoice.paid_amount ?? 0));

const statusLabel = (status?: string) => {
  if (status === "pending") return "รอชำระ";
  if (status === "partial") return "ชำระบางส่วน";
  if (status === "overdue") return "เกินกำหนด";
  if (status === "verifying") return "รอตรวจสอบ";
  return status ?? "-";
};

const sanitizeStorageFileName = (fileName: string) => {
  const extensionIndex = fileName.lastIndexOf(".");
  const rawBase = extensionIndex >= 0 ? fileName.slice(0, extensionIndex) : fileName;
  const rawExtension = extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : "";
  const safeBase = rawBase
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const safeExtension = rawExtension.replace(/[^.a-z0-9]/g, "");
  return `${safeBase || "upload"}${safeExtension}`;
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
      onProgress(Math.round((event.loaded / event.total) * 100));
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

export default function PaymentLiffCurrentInvoicesPage() {
  const [accessToken, setAccessToken] = useState("");
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [unpaidInvoices, setUnpaidInvoices] = useState<InvoiceRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [slipFile, setSlipFile] = useState<File | null>(null);

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
          setMessage("ไม่พบ NEXT_PUBLIC_PAYMENT_LIFF_ID ใน .env.local");
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

        const nextAccessToken = liff.getAccessToken() || "";
        setAccessToken(nextAccessToken);

        const response = await fetch("/api/payment-liff/invoices", {
          method: "POST",
          headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
          body: JSON.stringify({ accessToken: nextAccessToken }),
        });

        const data = await response.json();
        if (!response.ok) {
          setMessage(data?.error ?? "โหลดข้อมูลบิลไม่สำเร็จ");
          setLoading(false);
          return;
        }

        const nextTenant = (data?.tenant ?? null) as TenantInfo | null;
        if (!nextTenant) {
          setMessage(data?.message ?? "ยังไม่ได้ลงทะเบียนผู้เช่า");
          setLoading(false);
          return;
        }
        if (!nextTenant.policy_accepted) {
          window.location.replace("/payment/liff");
          return;
        }

        const invoices = (data.pending_invoices ?? data.invoices ?? []) as InvoiceRow[];
        setTenant(nextTenant);
        setUnpaidInvoices(invoices);
        setSelectedIds(invoices.map((invoice) => invoice.id));
        setLoading(false);
      } catch (error: any) {
        setMessage(error?.message ?? "เกิดข้อผิดพลาดในการเชื่อมต่อ LIFF");
        setLoading(false);
      }
    };

    void boot();
  }, []);

  const selectedInvoices = useMemo(
    () => unpaidInvoices.filter((invoice) => selectedIds.includes(invoice.id)),
    [unpaidInvoices, selectedIds]
  );

  const grandTotal = useMemo(
    () => selectedInvoices.reduce((sum, invoice) => sum + outstandingAmount(invoice), 0),
    [selectedInvoices]
  );

  const toggleInvoice = (invoiceId: string) => {
    setSelectedIds((prev) =>
      prev.includes(invoiceId) ? prev.filter((id) => id !== invoiceId) : [...prev, invoiceId]
    );
  };

  const handleSubmit = async () => {
    if (!tenant) return;
    if (!accessToken) {
      setMessage("Session หมดอายุ กรุณาเข้าใหม่อีกครั้ง");
      return;
    }
    if (selectedIds.length === 0) {
      setMessage("กรุณาเลือกอย่างน้อย 1 บิล");
      return;
    }
    if (!slipFile) {
      setMessage("กรุณาอัปโหลดสลิปก่อนส่งข้อมูล");
      return;
    }

    setSubmitting(true);
    setMessage(null);
    setUploadProgress(0);

    try {
      const safeName = sanitizeStorageFileName(slipFile.name);
      const filePath = `payment-liff/${tenant.id}/${Date.now()}-${safeName}`;
      await uploadToSupabaseWithProgress(slipFile, "payment_slips", filePath, setUploadProgress);

      const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (!baseUrl) throw new Error("Supabase URL is missing.");
      const slipUrl = `${baseUrl}/storage/v1/object/public/payment_slips/${filePath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`;

      const response = await fetch("/api/payment-liff/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
        body: JSON.stringify({ accessToken, invoiceIds: selectedIds, slipUrl }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error ?? "ส่งข้อมูลชำระเงินไม่สำเร็จ");
      }

      setSubmitted(true);
      setUnpaidInvoices((prev) =>
        prev.map((invoice) => (selectedIds.includes(invoice.id) ? { ...invoice, status: "verifying" } : invoice))
      );
    } catch (error: any) {
      setMessage(error?.message ?? "ส่งข้อมูลชำระเงินไม่สำเร็จ");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-md space-y-4">
        <a href="/payment/liff" className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600">
          <ArrowLeft size={16} /> กลับไปหน้าเมนูผู้เช่า
        </a>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">ใบแจ้งหนี้ปัจจุบัน</h1>
          <p className="mt-1 text-sm text-slate-500">เลือกบิลที่ต้องการชำระและอัปโหลดสลิปได้ในหน้านี้</p>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
            กำลังโหลดข้อมูล...
          </div>
        ) : (
          <div className="space-y-3">
            {message && <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{message}</div>}

            {submitted && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                ส่งข้อมูลชำระเงินเรียบร้อยแล้ว ระบบกำลังรอตรวจสอบสลิปของคุณ
              </div>
            )}

            {unpaidInvoices.length > 0 && (
              <>
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  หากเกินกำหนดชำระอาจมีค่าปรับตามนโยบายหอพัก
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-900">บิลค้างชำระ ({unpaidInvoices.length})</p>
                    <button
                      type="button"
                      onClick={() => setSelectedIds(unpaidInvoices.map((invoice) => invoice.id))}
                      className="text-xs font-semibold text-blue-600"
                    >
                      เลือกทั้งหมด
                    </button>
                  </div>

                  <div className="mt-3 space-y-2">
                    {unpaidInvoices.map((invoice) => {
                      const checked = selectedIds.includes(invoice.id);
                      const outstanding = outstandingAmount(invoice);
                      return (
                        <label
                          key={invoice.id}
                          className={`block rounded-xl border px-3 py-3 ${
                            checked ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white"
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleInvoice(invoice.id)}
                              className="mt-1"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-semibold text-slate-900">
                                    งวด{" "}
                                    {new Date(invoice.issue_date).toLocaleDateString("th-TH", {
                                      month: "long",
                                      year: "numeric",
                                    })}
                                  </p>
                                  <p className="mt-1 text-xs text-slate-500">
                                    ครบกำหนด {new Date(invoice.due_date).toLocaleDateString("th-TH")}
                                  </p>
                                </div>
                                <span className="rounded-full bg-slate-100 px-2 py-1 text-2xs text-slate-700">
                                  {statusLabel(invoice.status)}
                                </span>
                              </div>
                              <p className="mt-2 text-sm font-semibold text-rose-700">คงเหลือ ฿{formatMoney(outstanding)}</p>
                              {(invoice.late_fee_amount ?? 0) > 0 && (
                                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                                  <p className="text-2xs font-semibold text-amber-900">
                                    รวมค่าปรับล่าช้า: ฿{formatMoney(invoice.late_fee_amount ?? 0)}
                                  </p>
                                </div>
                              )}
                              <a
                                href={`/payment/${invoice.public_token}`}
                                className="mt-2 inline-block text-xs font-semibold text-blue-600"
                              >
                                ดูรายละเอียดบิล
                              </a>
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-sm text-slate-500">ยอดรวมที่เลือกชำระ</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">฿{formatMoney(grandTotal)}</p>
                  <p className="mt-2 text-xs text-slate-500">เลือก {selectedIds.length} รายการ</p>

                  <label className="mt-4 block text-sm font-medium text-slate-700">
                    อัปโหลดสลิป
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => setSlipFile(event.target.files?.[0] ?? null)}
                      className="mt-2 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    />
                  </label>

                  {submitting && <p className="mt-3 text-xs text-slate-500">กำลังอัปโหลด {uploadProgress}%</p>}

                  <button
                    type="button"
                    onClick={() => void handleSubmit()}
                    disabled={submitting || selectedIds.length === 0}
                    className="mt-4 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {submitting ? "กำลังส่งข้อมูล..." : "ส่งสลิปการชำระเงิน"}
                  </button>
                </div>
              </>
            )}

            {unpaidInvoices.length === 0 && !submitted && (
              <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
                ไม่พบบิลค้างชำระ
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
