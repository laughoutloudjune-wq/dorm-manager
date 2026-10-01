"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Banknote, CheckCircle2 } from "lucide-react";
import { SectionCard } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Input, Select } from "@/components/ui/Input";
import { EmptyState, Notice, Tabs } from "@/components/ui/Page";
import { TBody, TD, TH, THead, TR, Table } from "@/components/ui/Table";
import { createClient } from "@/lib/supabase-client";
import { formatMoney } from "@/lib/format";
import { bangkokYmd } from "@/lib/move-out-notice";
import { moveOutIssueText } from "@/lib/move-out-messages";
import { callTenantsAction, TenantsActionError } from "@/lib/tenants-action-client";
import {
  REFUND_METHOD_LABELS,
  refundMethodLabel,
  refundPaidAtIso,
  summarizeRefunds,
  type RefundView,
} from "@/lib/refunds";

type PaymentMethodOption = {
  id: string;
  label: string | null;
  bank_name: string | null;
  account_name: string | null;
  account_number: string | null;
};

const thaiDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" });
};

const methodOptionLabel = (m: PaymentMethodOption) =>
  [m.label, m.bank_name, m.account_name, m.account_number].filter(Boolean).join(" · ") || "บัญชีไม่มีชื่อ";

/**
 * Move-out refunds — money OUT. settle_move_out records any credit left after
 * the tenant's bills as a pending refund; when the owner has actually
 * transferred it, "บันทึกจ่ายคืน" calls mark_refund_paid with the date and the
 * account it left from (frozen server-side from payment_methods).
 */
export function RefundsSection({
  refunds,
  loading,
  canMarkPaid,
  onChanged,
}: {
  refunds: RefundView[];
  loading: boolean;
  canMarkPaid: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<"pending" | "paid">("pending");
  const [paying, setPaying] = useState<RefundView | null>(null);

  const pending = summarizeRefunds(refunds, "pending");
  const paid = summarizeRefunds(refunds, "paid");
  const rows = useMemo(() => refunds.filter((r) => r.status === tab), [refunds, tab]);

  return (
    <SectionCard
      title="เงินคืนผู้เช่า (เงินออก)"
      description={`รอคืน ${pending.count} รายการ ฿${formatMoney(pending.total)} · คืนแล้ว ${paid.count} รายการ ฿${formatMoney(paid.total)}`}
      action={
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "pending", label: "รอคืนเงิน", count: pending.count },
            { value: "paid", label: "คืนแล้ว", count: paid.count },
          ]}
        />
      }
      bodyClassName="p-0"
    >
      {loading ? (
        <div className="px-5 py-10 text-center text-sm text-slate-500">กำลังโหลด…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Banknote className="h-5 w-5" />}
          title={tab === "pending" ? "ไม่มีเงินคืนที่รอจ่าย" : "ยังไม่มีรายการคืนเงิน"}
          description="เงินคืนเกิดจากการสรุปยอดย้ายออกที่มีเครดิต (เงินประกัน + ค่าเช่าล่วงหน้า) เหลือหลังหักบิล"
        />
      ) : (
        <div className="scrollbar-slim overflow-x-auto">
          <Table className="min-w-[760px]">
            <THead>
              <tr>
                <TH>ผู้เช่า</TH>
                <TH>ห้อง</TH>
                <TH className="text-right">ยอดคืน</TH>
                <TH>สรุปยอดเมื่อ</TH>
                <TH>{tab === "pending" ? "สถานะ" : "จ่ายคืนเมื่อ"}</TH>
                {tab === "paid" && <TH>ช่องทาง / บัญชี</TH>}
                {tab === "pending" && <TH className="w-40" />}
              </tr>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD className="font-medium text-slate-900">{r.tenantName}</TD>
                  <TD>
                    {r.room}
                    {r.building !== "-" ? ` · ${r.building}` : ""}
                  </TD>
                  <TD className="text-right font-semibold tabular-nums">฿{formatMoney(r.amount)}</TD>
                  <TD>{thaiDate(r.createdAt)}</TD>
                  <TD>
                    {r.status === "pending" ? (
                      <Badge variant="warning" dot>
                        รอคืนเงิน
                      </Badge>
                    ) : (
                      thaiDate(r.paidAt)
                    )}
                  </TD>
                  {tab === "paid" && (
                    <TD>
                      {refundMethodLabel(r.method)}
                      {r.accountLabel ? ` · ${r.accountLabel}` : ""}
                    </TD>
                  )}
                  {tab === "pending" && (
                    <TD className="text-right">
                      <Button
                        size="sm"
                        variant="subtle"
                        disabled={!canMarkPaid}
                        title={!canMarkPaid ? "ต้องมีสิทธิ์บันทึกการรับชำระและแก้ไขผู้เช่า" : undefined}
                        onClick={() => setPaying(r)}
                        icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                      >
                        บันทึกจ่ายคืน
                      </Button>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      {paying && (
        <MarkRefundPaidModal
          refund={paying}
          onClose={() => setPaying(null)}
          onDone={async () => {
            setPaying(null);
            await onChanged();
          }}
        />
      )}
    </SectionCard>
  );
}

function MarkRefundPaidModal({
  refund,
  onClose,
  onDone,
}: {
  refund: RefundView;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const today = bangkokYmd();
  const [paidDate, setPaidDate] = useState(today);
  const [method, setMethod] = useState<string>("bank_transfer");
  const [paymentMethodId, setPaymentMethodId] = useState("");
  const [methods, setMethods] = useState<PaymentMethodOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const { data } = await createClient().auth.getSession();
        const token = data.session?.access_token;
        if (!token) return;
        const res = await fetch("/api/admin/settings/payment-methods", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json().catch(() => ({}));
        if (mounted && res.ok) setMethods((json.methods ?? []) as PaymentMethodOption[]);
      } catch {
        // The account list is optional; the dialog still works without it.
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  const dateError = !paidDate ? "กรุณาระบุวันที่" : paidDate > today ? "วันที่จ่ายคืนต้องไม่เป็นวันในอนาคต" : null;
  const accountRequired = method === "bank_transfer";
  const accountError = accountRequired && !paymentMethodId ? "เลือกบัญชีที่โอนเงินคืนออกไป" : null;

  const submit = async () => {
    setBusy(true);
    setErrorText(null);
    try {
      await callTenantsAction("mark_refund_paid", {
        refundId: refund.id,
        paidAt: refundPaidAtIso(paidDate, today),
        method,
        paymentMethodId: accountRequired ? paymentMethodId : null,
      });
      toast.success(`บันทึกจ่ายคืน ฿${formatMoney(refund.amount)} ให้ ${refund.tenantName} แล้ว`);
      await onDone();
    } catch (error) {
      const text =
        error instanceof TenantsActionError
          ? moveOutIssueText({ code: error.code ?? "", message: error.message })
          : (error as any)?.message ?? "บันทึกไม่สำเร็จ";
      setErrorText(text);
      toast.error(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={busy ? () => undefined : onClose}
      title="บันทึกจ่ายเงินคืน"
      description={`${refund.tenantName} · ห้อง ${refund.room} · ฿${formatMoney(refund.amount)}`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button
            variant="success"
            onClick={submit}
            loading={busy}
            disabled={Boolean(dateError || accountError)}
            icon={<CheckCircle2 className="h-4 w-4" />}
          >
            บันทึกจ่ายคืน
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="วันที่จ่ายคืน"
          type="date"
          value={paidDate}
          max={today}
          onChange={(e) => setPaidDate(e.target.value)}
          error={dateError ?? undefined}
          required
        />
        <Select label="ช่องทาง" value={method} onChange={(e) => setMethod(e.target.value)} required>
          {Object.entries(REFUND_METHOD_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        {accountRequired && (
          <Select
            label="โอนจากบัญชี"
            value={paymentMethodId}
            onChange={(e) => setPaymentMethodId(e.target.value)}
            error={accountError ?? undefined}
            required
          >
            <option value="">เลือกบัญชี</option>
            {methods.map((m) => (
              <option key={m.id} value={m.id}>
                {methodOptionLabel(m)}
              </option>
            ))}
          </Select>
        )}
        <Notice tone="info">
          เงินคืนจะแสดงในรายงานเป็น “เงินออก” แยกจากรายรับ และบันทึกแล้วแก้ไขไม่ได้ — ตรวจสอบยอดและวันที่ก่อนกดบันทึก
        </Notice>
        {errorText && <Notice tone="danger">{errorText}</Notice>}
      </div>
    </Modal>
  );
}
