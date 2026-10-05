"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState, Notice, Skeleton } from "@/components/ui/Page";
import { Table, TableCard, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { CREDIT_LABELS } from "@/lib/money/credits-refunds-view";
import { postRefundAction } from "./api";
import { canVoidSettlement } from "./form-logic";
import { VoidSettlementModal } from "./RefundModals";

type Settlement = {
  id: string;
  tenantId: string;
  tenantName: string | null;
  roomNumber: string | null;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  refundDue: number;
  refundPaid: number;
  livePayouts: number;
};

const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function SettlementsSection({
  canVoid,
  refreshKey,
  onChanged,
}: {
  canVoid: boolean;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<Settlement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Settlement | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const json = await postRefundAction<{ settlements: Settlement[] }>({ action: "list_settlements" });
      setRows(json.settlements ?? []);
    } catch (e: any) {
      setError(e?.message ?? "โหลดรายการสรุปยอดไม่สำเร็จ");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-base font-semibold text-slate-900">การสรุปยอดย้ายออก (Settlements)</h2>
        <p className="mt-0.5 text-xs text-slate-500">การสรุปยอดที่ยกเลิกแล้วจะยังแสดงพร้อมเหตุผล</p>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!rows && !error ? (
        <Skeleton className="h-24" />
      ) : rows && rows.length === 0 ? (
        <Card>
          <EmptyState title="ยังไม่มีการสรุปยอดย้ายออก" />
        </Card>
      ) : rows ? (
        <TableCard>
          <Table>
            <THead>
              <TR>
                <TH>ผู้เช่า</TH>
                <TH>ห้อง</TH>
                <TH>วันที่</TH>
                <TH className="text-right">{CREDIT_LABELS.refundDue}</TH>
                <TH className="text-right">{CREDIT_LABELS.refundPaid}</TH>
                <TH className="text-right">รายการจ่ายคืนที่ยังมีผล</TH>
                <TH>สถานะ</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {rows.map((s) => (
                <TR key={s.id} className={s.voidedAt ? "text-slate-400" : undefined}>
                  <TD>{s.tenantName ?? "-"}</TD>
                  <TD>{s.roomNumber ?? "-"}</TD>
                  <TD className="whitespace-nowrap">{new Date(s.createdAt).toLocaleDateString("th-TH")}</TD>
                  <TD className="text-right tabular-nums">{baht(s.refundDue)}</TD>
                  <TD className="text-right tabular-nums">{baht(s.refundPaid)}</TD>
                  <TD className="text-right tabular-nums">{s.livePayouts}</TD>
                  <TD>
                    <Badge variant={s.voidedAt ? "neutral" : "success"} size="sm" dot>
                      {s.voidedAt ? "ยกเลิกแล้ว (voided)" : "ใช้งานอยู่ (active)"}
                    </Badge>
                    {s.voidedAt && s.voidReason ? <p className="mt-1 text-2xs text-slate-400">{s.voidReason}</p> : null}
                  </TD>
                  <TD>
                    {!s.voidedAt && canVoid ? (
                      <div className="space-y-1">
                        <Button variant="danger" size="sm" disabled={!canVoidSettlement(s)} onClick={() => setTarget(s)}>
                          ยกเลิกการสรุปยอด
                        </Button>
                        {s.livePayouts > 0 ? (
                          <p className="text-2xs text-slate-500">ต้องยกเลิกรายการจ่ายเงินคืนก่อน</p>
                        ) : null}
                      </div>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableCard>
      ) : null}
      <VoidSettlementModal
        settlement={target}
        onClose={() => setTarget(null)}
        onDone={() => {
          setTarget(null);
          onChanged();
        }}
      />
    </section>
  );
}
