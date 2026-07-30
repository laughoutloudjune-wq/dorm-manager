"use client";

import { useEffect, useState } from "react";
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
  total_amount: number;
  paid_amount?: number;
};

const NGROK_SKIP_QUERY = "ngrok-skip-browser-warning=true";

const formatMoney = (value: number) =>
  Number(value || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PaymentLiffInvoiceHistoryPage() {
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [paidInvoices, setPaidInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);

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

        const response = await fetch("/api/payment-liff/invoices", {
          method: "POST",
          headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
          body: JSON.stringify({ accessToken: nextAccessToken }),
        });

        const data = await response.json();
        if (!response.ok) {
          setMessage(data?.error ?? "โหลดข้อมูลไม่สำเร็จ");
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

        setTenant(nextTenant);
        setPaidInvoices((data.paid_invoices ?? []) as InvoiceRow[]);
        setLoading(false);
      } catch (error: any) {
        setMessage(error?.message ?? "เกิดข้อผิดพลาดในการเชื่อมต่อ LIFF");
        setLoading(false);
      }
    };

    void boot();
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-md space-y-4">
        <a href="/payment/liff" className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600">
          <ArrowLeft size={16} /> กลับไปหน้าเมนูผู้เช่า
        </a>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">ใบแจ้งหนี้ย้อนหลัง</h1>
          <p className="mt-1 text-sm text-slate-500">ประวัติการชำระเงินและใบเสร็จรับเงิน</p>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
            กำลังโหลดข้อมูล...
          </div>
        ) : (
          <>
            {message && <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{message}</div>}

            {tenant &&
              (paidInvoices.length === 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
                  ยังไม่มีประวัติการชำระเงิน
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="space-y-2">
                    {paidInvoices.map((invoice) => (
                      <div
                        key={invoice.id}
                        className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-900">
                            งวด{" "}
                            {new Date(invoice.issue_date).toLocaleDateString("th-TH", {
                              month: "long",
                              year: "numeric",
                            })}
                          </p>
                          <p className="text-xs text-slate-500">
                            ยอดชำระ ฿{formatMoney(Number(invoice.paid_amount ?? invoice.total_amount ?? 0))}
                          </p>
                        </div>
                        <a
                          href={`/api/receipt/${invoice.public_token}`}
                          className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white"
                        >
                          ดาวน์โหลด PDF
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
          </>
        )}
      </div>
    </div>
  );
}
