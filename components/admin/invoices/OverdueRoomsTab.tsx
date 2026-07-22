"use client";

import { useEffect, useState, useMemo } from "react";
import { createClient } from "@/lib/supabase-client";
import { formatMoney, toLocalDateString } from "@/lib/format";
import { statusLabelThai, statusPillClass, invoiceDisplayOutstanding } from "@/lib/invoice-utils";
import { useInvoiceContext } from "./InvoiceContext";
import { ChevronDown, ChevronUp, AlertCircle, Building, DoorOpen } from "lucide-react";

type RawInvoice = any;

interface OverdueRoomGroup {
  room_number: string;
  building_name: string;
  tenant_name: string;
  total_outstanding: number;
  invoices: RawInvoice[];
}

export function OverdueRoomsTab() {
  const { openInvoice } = useInvoiceContext();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<RawInvoice[]>([]);
  const [expandedRooms, setExpandedRooms] = useState<Set<string>>(new Set());

  const supabase = createClient();

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await supabase
        .from("invoices")
        .select(
          "id, public_token, issue_date, start_date, due_date, total_amount, paid_amount, status, late_fee_amount, rent_amount, water_bill, electricity_bill, common_fee, additional_fees_total, carry_forward_amount, discount_amount, tenants(full_name, phone_number), rooms(room_number, buildings(name))"
        )
        .in("status", ["pending", "partial", "overdue", "verifying"])
        .order("start_date", { ascending: true });

      if (fetchError) throw fetchError;
      setInvoices(data ?? []);
    } catch (err: any) {
      setError(err.message || "Failed to load overdue invoices.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, OverdueRoomGroup>();

    for (const inv of invoices) {
      const roomRel = Array.isArray(inv.rooms) ? inv.rooms[0] : inv.rooms;
      const tenantRel = Array.isArray(inv.tenants) ? inv.tenants[0] : inv.tenants;
      const buildingRel = Array.isArray(roomRel?.buildings) ? roomRel.buildings[0] : roomRel?.buildings;

      const roomNumber = roomRel?.room_number ?? "ไม่มีห้อง";
      const buildingName = buildingRel?.name ?? "ไม่มีอาคาร";
      const tenantName = tenantRel?.full_name ?? "ไม่มีผู้เช่า";

      if (!map.has(roomNumber)) {
        map.set(roomNumber, {
          room_number: roomNumber,
          building_name: buildingName,
          tenant_name: tenantName,
          total_outstanding: 0,
          invoices: [],
        });
      }

      const group = map.get(roomNumber)!;
      group.invoices.push(inv);
      group.total_outstanding += invoiceDisplayOutstanding(inv);
    }

    // Convert to array and sort by total outstanding (descending)
    return Array.from(map.values())
      .filter((g) => g.total_outstanding > 0)
      .sort((a, b) => b.total_outstanding - a.total_outstanding);
  }, [invoices]);

  const toggleExpand = (roomNumber: string) => {
    setExpandedRooms((prev) => {
      const next = new Set(prev);
      if (next.has(roomNumber)) next.delete(roomNumber);
      else next.add(roomNumber);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center rounded-card border border-slate-200 bg-white">
        <span className="text-sm font-medium text-slate-400 animate-pulse">กำลังโหลดข้อมูล...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-card border border-danger-200 bg-danger-50 p-4 text-sm text-danger-600">
        <AlertCircle className="inline mr-2" size={16} />
        {error}
      </div>
    );
  }

  if (grouped.length === 0) {
    return (
      <div className="rounded-card border border-slate-200 bg-white p-8 text-center text-slate-500">
        ไม่มีห้องที่มียอดค้างชำระในขณะนี้ 🎉
      </div>
    );
  }

  const grandTotal = grouped.reduce((sum, g) => sum + g.total_outstanding, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-card border border-danger-200 bg-danger-50 px-5 py-4 text-danger-900 shadow-sm">
        <div>
          <h2 className="text-lg font-bold">ยอดค้างชำระรวมทั้งสิ้น</h2>
          <p className="text-xs text-danger-700/80 mt-1">
            ทั้งหมด {grouped.length} ห้อง ({invoices.length} บิล)
          </p>
        </div>
        <div className="text-2xl font-black">{formatMoney(grandTotal)}</div>
      </div>

      <div className="space-y-3">
        {grouped.map((group) => {
          const isExpanded = expandedRooms.has(group.room_number);
          return (
            <div
              key={group.room_number}
              className="overflow-hidden rounded-card border border-slate-200 bg-white shadow-sm transition-all hover:border-slate-300"
            >
              <button
                onClick={() => toggleExpand(group.room_number)}
                className="flex w-full items-center justify-between p-4 text-left focus:outline-none"
              >
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-control bg-slate-100 text-slate-700">
                    <DoorOpen size={24} />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">
                      ห้อง {group.room_number}
                    </h3>
                    <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                      <span className="flex items-center gap-1">
                        <Building size={12} /> {group.building_name}
                      </span>
                      <span>•</span>
                      <span className="font-medium text-slate-700">{group.tenant_name}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-xs text-danger-600 font-medium mb-1">{group.invoices.length} บิล</p>
                    <p className="text-lg font-bold text-danger-700">฿{formatMoney(group.total_outstanding)}</p>
                  </div>
                  <div className="text-slate-400">
                    {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                  </div>
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-slate-100 bg-slate-50/50 p-4">
                  <div className="space-y-2">
                    {group.invoices.map((inv) => {
                      const outstanding = invoiceDisplayOutstanding(inv);
                      return (
                        <div
                          key={inv.id}
                          onClick={() => openInvoice(inv)}
                          className="flex cursor-pointer items-center justify-between rounded-control border border-slate-200 bg-white p-3 hover:border-primary-300 hover:shadow-sm transition-colors"
                        >
                          <div>
                            <p className="text-sm font-semibold text-slate-800">
                              บิลเดือน {new Date(inv.start_date).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })}
                            </p>
                            <p className="mt-1 text-2xs text-slate-500">
                              กำหนดชำระ: {new Date(inv.due_date).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}
                              {" • "}
                              ยอดรวมบิล: ฿{formatMoney(inv.total_amount)}
                            </p>
                          </div>
                          <div className="text-right">
                            <span className={`inline-block rounded-full px-2 py-0.5 text-2xs font-semibold ${statusPillClass(inv.status)}`}>
                              {statusLabelThai(inv.status)}
                            </span>
                            <p className="mt-1 text-sm font-bold text-danger-700">
                              ค้าง ฿{formatMoney(outstanding)}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
