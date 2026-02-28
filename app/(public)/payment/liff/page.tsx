"use client";

import { useEffect, useState } from "react";

type LiffProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
};

type InvoiceRow = {
  id: string;
  public_token: string;
  issue_date: string;
  due_date: string;
  total_amount: number;
  paid_amount?: number;
  status?: string;
};

type TenantInfo = {
  id: string;
  full_name: string;
  room_number: string;
  has_corporate_receipt?: boolean;
};

const NGROK_SKIP_QUERY = "ngrok-skip-browser-warning=true";

export default function PaymentLiffPage() {
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showRegisterButton, setShowRegisterButton] = useState(false);
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

        const nextProfile = await liff.getProfile();
        setProfile({
          userId: nextProfile.userId,
          displayName: nextProfile.displayName,
          pictureUrl: nextProfile.pictureUrl,
        });

        const accessToken = liff.getAccessToken();
        const response = await fetch("/api/payment-liff/invoices", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "true",
          },
          body: JSON.stringify({ accessToken }),
        });

        const data = await response.json();
        if (!response.ok) {
          setMessage(data?.error ?? "โหลดข้อมูลบิลไม่สำเร็จ");
          setLoading(false);
          return;
        }

        const tenant = (data?.tenant ?? null) as TenantInfo | null;
        if (!tenant) {
          setMessage(data?.message ?? "ยังไม่ได้ลงทะเบียนผู้เช่า");
          setShowRegisterButton(true);
          setLoading(false);
          return;
        }

        const invoices = (data.pending_invoices ?? data.invoices ?? []) as InvoiceRow[];
        const paid = (data.paid_invoices ?? []) as InvoiceRow[];
        setPaidInvoices(paid);

        if (invoices.length === 0) {
          if (paid.length > 0 && !tenant.has_corporate_receipt) {
            const latestPaid = paid[0];
            window.location.replace(`/payment/${latestPaid.public_token}`);
            return;
          }
          setMessage("ไม่พบบิลค้างชำระ");
          setLoading(false);
          return;
        }

        const latest = invoices[0];
        window.location.replace(`/payment/${latest.public_token}`);
      } catch (error: any) {
        setMessage(error?.message ?? "เกิดข้อผิดพลาดในการเชื่อมต่อ LIFF");
        setLoading(false);
      }
    };

    void boot();
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-md space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">ชำระค่าเช่าผ่าน LINE</h1>
          <p className="mt-1 text-sm text-slate-500">กำลังพาไปยังใบแจ้งหนี้ล่าสุด...</p>
        </div>

        {profile && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-semibold text-slate-900">{profile.displayName}</p>
          </div>
        )}

        {loading ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
            กำลังโหลดข้อมูล...
          </div>
        ) : (
          <div className="space-y-3">
            {message && (
              <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{message}</div>
            )}
            {!showRegisterButton && paidInvoices.length > 0 && (
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-sm font-semibold text-slate-900">ใบเสร็จรับเงิน (ดาวน์โหลด PDF)</p>
                <div className="mt-3 space-y-2">
                  {paidInvoices.map((invoice) => (
                    <div
                      key={invoice.id}
                      className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900">
                          งวด {new Date(invoice.issue_date).toLocaleDateString("th-TH", { month: "long", year: "numeric" })}
                        </p>
                        <p className="text-xs text-slate-500">
                          ยอดชำระ ฿
                          {Number(invoice.paid_amount ?? invoice.total_amount ?? 0).toLocaleString("th-TH", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
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
            )}
            {showRegisterButton && (
              <a
                href="/register"
                className="block rounded-xl bg-blue-600 px-4 py-2.5 text-center text-sm font-semibold text-white"
              >
                ไปหน้าลงทะเบียนผู้เช่า
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
