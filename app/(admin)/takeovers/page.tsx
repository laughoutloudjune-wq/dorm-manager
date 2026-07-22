"use client";

import { toast } from "sonner";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState, Notice, PageHeader } from "@/components/ui/Page";
import { Table, TableCard, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";
import { Building2, ChevronRight, Inbox, RefreshCw } from "lucide-react";

type TakeoverRow = {
  id: string;
  room_id: string;
  requester_full_name: string;
  requester_phone: string;
  status: string;
  created_at: string | null;
  rooms?: {
    room_number: string;
    buildings?: { name: string } | { name: string }[];
  } | null;
};

const getBuildingName = (rooms: TakeoverRow["rooms"]) => {
  if (!rooms) return "—";
  const b = rooms.buildings;
  if (!b) return "—";
  return Array.isArray(b) ? b[0]?.name ?? "—" : b?.name ?? "—";
};

const statusLabel = (s: string) => {
  if (s === "requested") return "รอตรวจสอบ";
  if (s === "approved") return "อนุมัติแล้ว";
  if (s === "rejected") return "ไม่อนุมัติ";
  if (s === "cancelled") return "ยกเลิก";
  return s;
};

const statusBadgeVariant = (s: string) => {
  if (s === "requested") return "warning";
  if (s === "approved") return "success";
  if (s === "rejected") return "default";
  if (s === "cancelled") return "default";
  return "default";
};

export default function TakeoversAdminPage() {
  const supabase = useMemo(() => createClient(), []);
  const { can, loading: permLoading } = usePermissions();
  const canView = can("tenant.view") || can("tenant.edit");

  const [loading, setLoading] = useState(true);
  const [requests, setRequests] = useState<TakeoverRow[]>([]);

  const load = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    const { data, error: fetchError } = await supabase
      .from("room_takeover_requests")
      .select(
        "id,room_id,requester_full_name,requester_phone,status,created_at,rooms(room_number,buildings(name))"
      )
      .eq("status", "requested")
      .order("created_at", { ascending: false });

    if (fetchError) {
      toast.error(fetchError.message);
      setRequests([]);
      setLoading(false);
      return;
    }

    setRequests((data ?? []) as unknown as TakeoverRow[]);
    setLoading(false);
  }, [canView, supabase]);

  useEffect(() => {
    if (!permLoading && canView) void load();
  }, [permLoading, canView, load]);

  const approve = async (requestId: string) => {
    if (!can("tenant.edit")) {
      toast.error("คุณไม่มีสิทธิ์อนุมัติคำขอนี้");
      return;
    }
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      toast.error("Session หมดอายุ กรุณาเข้าสู่ระบบใหม่");
      return;
    }

    const response = await fetch("/api/admin/takeovers/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "approve", requestId }),
    });
    const dataJson = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast.error(dataJson?.error ?? "อนุมัติไม่สำเร็จ");
      return;
    }
    await load();
  };

  const reject = async (requestId: string) => {
    if (!can("tenant.edit")) {
      toast.error("คุณไม่มีสิทธิ์ปฏิเสธคำขอนี้");
      return;
    }
    const note = window.prompt("หมายเหตุสำหรับการปฏิเสธ (ไม่บังคับ):") ?? null;

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      toast.error("Session หมดอายุ กรุณาเข้าสู่ระบบใหม่");
      return;
    }

    const response = await fetch("/api/admin/takeovers/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "reject", requestId, adminNote: note }),
    });
    const dataJson = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast.error(dataJson?.error ?? "ปฏิเสธไม่สำเร็จ");
      return;
    }
    await load();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        description="คำขอย้ายเข้าเมื่อห้องมีผู้เช่าอยู่แล้ว (อนุมัติ/ปฏิเสธโดยแอดมิน)"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />}
          >
            รีเฟรช
          </Button>
        }
      />

      {!permLoading && !canView && (
        <Notice tone="warning" title="ไม่มีสิทธิ์ดูข้อมูลนี้" />
      )}

      {canView && loading && (
        <Card>
          <EmptyState title="กำลังโหลด…" />
        </Card>
      )}

      {canView && !loading && (
        <TableCard>
          <Table className="min-w-[720px]">
            <THead>
              <tr>
                <TH>สถานะ</TH>
                <TH>ผู้ขอ</TH>
                <TH>ห้อง / อาคาร</TH>
                <TH>คำขอ</TH>
              </tr>
            </THead>
            <TBody>
              {requests.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <EmptyState
                      icon={<Inbox className="h-5 w-5" />}
                      title="ไม่มีคำขอที่รอดำเนินการ"
                      description="คำขอเข้าห้องจากผู้เช่าใหม่จะแสดงที่นี่"
                    />
                  </td>
                </tr>
              ) : (
                requests.map((row) => (
                  <TR key={row.id}>
                    <TD>
                      <Badge variant={statusBadgeVariant(row.status)} dot>
                        {statusLabel(row.status)}
                      </Badge>
                    </TD>
                    <TD>
                      <div className="font-medium text-slate-900">{row.requester_full_name}</div>
                      <div className="text-xs text-slate-500">{row.requester_phone}</div>
                    </TD>
                    <TD>
                      <span className="inline-flex items-center gap-1.5">
                        <Building2 className="h-3.5 w-3.5 text-slate-400" />
                        {row.rooms?.room_number ?? "—"} · {getBuildingName(row.rooms ?? null)}
                      </span>
                    </TD>
                    <TD>
                      <div className="flex items-center gap-2">
                        <Button size="sm" onClick={() => void approve(row.id)}>
                          อนุมัติ
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void reject(row.id)}>
                          ปฏิเสธ
                        </Button>
                      </div>
                      <div className="mt-2 flex items-center gap-1 text-xs text-slate-500">
                        <ChevronRight className="h-3 w-3" />
                        {row.created_at ? new Date(row.created_at).toLocaleString("th-TH") : ""}
                      </div>
                    </TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </TableCard>
      )}
    </div>
  );
}

