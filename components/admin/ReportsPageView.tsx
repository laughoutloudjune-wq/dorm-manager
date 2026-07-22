"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FileSpreadsheet, Loader2, Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { buttonClasses } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";

type ReportTab = "income" | "arrears" | "move_in" | "move_out" | "yearly" | "utilities" | "movement";

const toNumber = (value: any) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const formatMoney = (value: number) =>
  `฿${value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatDate = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString("th-TH") : "-";

const monthKey = (value: string) => String(value).slice(0, 7);
const yearStart = (year: number) => `${year}-01-01`;
const yearEnd = (year: number) => `${year + 1}-01-01`;
const relationItem = <T,>(value: T | T[] | null | undefined): T | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
const getBuildingName = (room: any) => relationItem(room?.buildings)?.name ?? "-";
const roomCompare = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
const byBuildingAndRoom = <
  T extends {
    building?: string;
    building_name?: string;
    room?: string;
    room_number?: string;
  },
>(
  left: T,
  right: T
) => {
  const leftBuilding = left.building ?? left.building_name ?? "-";
  const rightBuilding = right.building ?? right.building_name ?? "-";
  const buildingOrder = leftBuilding.localeCompare(rightBuilding, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (buildingOrder !== 0) return buildingOrder;
  return roomCompare(left.room ?? left.room_number ?? "-", right.room ?? right.room_number ?? "-");
};

const statusLabel = (status: string) =>
  ({
    draft: "ฉบับร่าง",
    pending: "รอชำระ",
    partial: "ชำระบางส่วน",
    verifying: "รอตรวจสอบ",
    paid: "ชำระแล้ว",
    overdue: "เกินกำหนด",
    cancelled: "ยกเลิก",
  } as Record<string, string>)[status] ?? status;

const getPaymentMethod = (invoice: any) => {
  const latestPayment = Array.isArray(invoice.payment_history) ? invoice.payment_history.at(-1) : null;
  const method = latestPayment?.method ?? latestPayment?.payment_method ?? invoice.tenant_custom_payment_method;
  if (!method) return "-";
  if (typeof method === "string") return method;
  return method.label ?? method.type ?? "-";
};

const getAdditionalFees = (rows: any[]) =>
  (Array.isArray(rows) ? rows : [])
    .filter((row) => String(row?.item_type ?? row?.type ?? "").toLowerCase() !== "transfer_detail")
    .map((row) => `${String(row?.detail ?? row?.label ?? "ค่าธรรมเนียม")} (${formatMoney(toNumber(row?.total_amount ?? row?.amount))})`)
    .join(", ");

const csvCell = (value: any) => {
  const text = String(value ?? "");
  return text.includes(",") || text.includes("\"") || text.includes("\n")
    ? `"${text.replaceAll("\"", "\"\"")}"`
    : text;
};

const downloadCsv = (filename: string, headers: string[], rows: Array<Array<string | number>>) => {
  const csv = [headers.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

export default function ReportsPageView() {
  const supabase = useMemo(() => createClient(), []);
  const { can, loading: permissionLoading } = usePermissions();
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [activeTab, setActiveTab] = useState<ReportTab>("income");
  const [loading, setLoading] = useState(true);
  const [incomeSearchQuery, setIncomeSearchQuery] = useState("");
  const [incomeBuildingFilter, setIncomeBuildingFilter] = useState("all");
  const [incomeStatusFilter, setIncomeStatusFilter] = useState("all");
  const [incomePaymentMethodFilter, setIncomePaymentMethodFilter] = useState("all");
  const [selectedIncomeInvoice, setSelectedIncomeInvoice] = useState<any>(null);
  const [movementSearchQuery, setMovementSearchQuery] = useState("");
  const [movementTypeFilter, setMovementTypeFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState({ water_rate: 0, electricity_rate: 0 });
  const [invoices, setInvoices] = useState<any[]>([]);
  const [tenants, setTenants] = useState<any[]>([]);
  const [meters, setMeters] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [transfers, setTransfers] = useState<any[]>([]);
  const [settlementInvoices, setSettlementInvoices] = useState<any[]>([]);

  const canViewReports = can("tenant.view") || can("room.view") || can("invoice.create");

  useEffect(() => {
    setSelectedMonth(`${selectedYear}-${String(new Date().getMonth() + 1).padStart(2, "0")}`);
  }, [selectedYear]);

  useEffect(() => {
    if (permissionLoading || !canViewReports) return;
    let mounted = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      const start = yearStart(selectedYear);
      const end = yearEnd(selectedYear);
      const [settingsRes, invoicesRes, tenantsRes, metersRes, logsRes, transfersRes, settlementInvoicesRes] = await Promise.all([
        supabase.from("settings").select("water_rate,electricity_rate").eq("id", 1).maybeSingle(),
        supabase
          .from("invoices")
          .select("id,tenant_id,room_id,status,total_amount,paid_amount,issue_date,due_date,start_date,end_date,rent_amount,water_bill,electricity_bill,common_fee,discount_amount,late_fee_amount,additional_fees_total,additional_fees_breakdown,payment_history,tenants(full_name,custom_payment_method),rooms(room_number,buildings(name))")
          .gte("start_date", start)
          .lt("start_date", end)
          .order("start_date", { ascending: true }),
        supabase
          .from("tenants")
          .select("id,room_id,full_name,move_in_date,move_out_date,advance_rent_amount,security_deposit_amount,rooms(room_number,buildings(name))")
          .order("move_in_date", { ascending: false }),
        supabase
          .from("meter_readings")
          .select("room_id,reading_month,electricity_usage,water_usage,rooms(room_number,buildings(name))")
          .gte("reading_month", start)
          .lt("reading_month", end)
          .order("reading_month", { ascending: true }),
        supabase
          .from("room_tenant_logs")
          .select("id,room_id,tenant_id,tenant_name,move_in_date,move_out_date,rooms(room_number,buildings(name))")
          .order("move_in_date", { ascending: false }),
        supabase
          .from("tenant_room_transfers")
          .select("id,tenant_id,from_room_id,to_room_id,transfer_date,old_electric_usage,old_water_usage,old_rent_amount,new_rent_amount")
          .gte("transfer_date", start)
          .lt("transfer_date", end)
          .order("transfer_date", { ascending: false }),
        // Final move-out settlement invoices (created by final_move_out) hold the
        // REAL deposit/advance credit applied (discount_amount) and the real net
        // amount (total_amount, negative when the tenant is owed a refund) — not
        // restricted to the selected year since a move-out invoice's billing
        // period can start in the prior year.
        supabase
          .from("invoices")
          .select("id,tenant_id,room_id,total_amount,discount_amount,notes,issue_date,rooms(room_number,buildings(name))")
          .ilike("notes", "ย้ายออก%")
          .order("issue_date", { ascending: false }),
      ]);

      if (!mounted) return;
      const firstError =
        settingsRes.error ||
        invoicesRes.error ||
        tenantsRes.error ||
        metersRes.error ||
        logsRes.error ||
        transfersRes.error ||
        settlementInvoicesRes.error;

      if (firstError) {
        setError(firstError.message);
        setLoading(false);
        return;
      }

      setSettings({
        water_rate: toNumber((settingsRes.data as any)?.water_rate),
        electricity_rate: toNumber((settingsRes.data as any)?.electricity_rate),
      });
      setInvoices(
        (invoicesRes.data ?? [])
          .filter((row: any) => String(row?.status ?? "") !== "draft")
          .map((row: any) => {
          const tenant = relationItem(row.tenants);
          const room = relationItem(row.rooms);
          return {
            ...row,
            tenant_name: tenant?.full_name ?? "-",
            tenant_custom_payment_method: tenant?.custom_payment_method ?? null,
            room_number: room?.room_number ?? "-",
            building_name: getBuildingName(room),
            total_amount: toNumber(row.total_amount),
            paid_amount: toNumber(row.paid_amount),
            rent_amount: toNumber(row.rent_amount),
            water_bill: toNumber(row.water_bill),
            electricity_bill: toNumber(row.electricity_bill),
            common_fee: toNumber(row.common_fee),
            discount_amount: toNumber(row.discount_amount),
            late_fee_amount: toNumber(row.late_fee_amount),
            additional_fees_total: toNumber(row.additional_fees_total),
            additional_fees_breakdown: Array.isArray(row.additional_fees_breakdown)
              ? row.additional_fees_breakdown
              : [],
            payment_history: Array.isArray(row.payment_history) ? row.payment_history : [],
          };
        })
      );
      setTenants(tenantsRes.data ?? []);
      setMeters(metersRes.data ?? []);
      setLogs(logsRes.data ?? []);
      setTransfers(transfersRes.data ?? []);
      setSettlementInvoices(settlementInvoicesRes.data ?? []);
      setLoading(false);
    };

    void load();
    return () => {
      mounted = false;
    };
  }, [canViewReports, permissionLoading, selectedYear, supabase]);

  const roomNumberById = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of [...meters, ...logs, ...tenants]) {
      const room = relationItem(row.rooms);
      if (row.room_id && room?.room_number) map.set(String(row.room_id), room.room_number);
    }
    return map;
  }, [logs, meters, tenants]);

  // final_move_out clears tenant.room_id once a tenant is fully settled, so looking
  // up a finalized tenant's room by their (now-null) room_id fails. room_tenant_logs
  // keeps the historical room_id/tenant_id pairing regardless, so use that instead.
  const roomByTenantId = useMemo(() => {
    const map = new Map<string, { room_number: string; building: string }>();
    for (const row of logs) {
      const room = relationItem(row.rooms);
      if (row.tenant_id && room?.room_number) {
        map.set(String(row.tenant_id), { room_number: room.room_number, building: getBuildingName(room) });
      }
    }
    return map;
  }, [logs]);

  // The real, authoritative settlement figures live on the final move-out invoice
  // (created by final_move_out) — discount_amount is the deposit/advance credit
  // ACTUALLY applied (already zeroed out if forfeited), and total_amount nets
  // that credit against the final charges (negative total_amount = tenant is
  // owed a cash refund beyond what covered their final bill).
  const settlementInvoiceByTenantId = useMemo(() => {
    const map = new Map<string, any>();
    for (const row of settlementInvoices) {
      const tenantId = String(row.tenant_id ?? "");
      if (!tenantId) continue;
      // Multiple settlement invoices could exist if a tenant record was somehow
      // finalized more than once; keep the most recent by issue_date (query is
      // already ordered descending, so the first one seen wins).
      if (!map.has(tenantId)) map.set(tenantId, row);
    }
    return map;
  }, [settlementInvoices]);

  const meterByRoomMonth = useMemo(() => {
    const map = new Map<string, any>();
    for (const row of meters) map.set(`${row.room_id}:${monthKey(row.reading_month)}`, row);
    return map;
  }, [meters]);

  const incomeRows = useMemo(
    () =>
      invoices.map((invoice) => {
        const meter = meterByRoomMonth.get(`${invoice.room_id}:${monthKey(invoice.start_date)}`);
        return {
          ...invoice,
          month: monthKey(invoice.start_date),
          building: invoice.building_name,
          electricityUsage: meter ? toNumber(meter.electricity_usage) : 0,
          waterUsage: meter ? toNumber(meter.water_usage) : 0,
          paymentMethod: getPaymentMethod(invoice),
          additionalFeeText: getAdditionalFees(invoice.additional_fees_breakdown) || "-",
        };
      }),
    [invoices, meterByRoomMonth]
  );

  const incomeBuildingOptions = useMemo(() => Array.from(new Set(incomeRows.filter(r => r.month === selectedMonth).map((r) => r.building_name).filter(Boolean))), [incomeRows, selectedMonth]);
  const incomePaymentMethodOptions = useMemo(() => Array.from(new Set(incomeRows.filter(r => r.month === selectedMonth).map((r) => r.paymentMethod).filter(Boolean))), [incomeRows, selectedMonth]);

  const filteredIncomeRows = useMemo(() => {
    let rows = incomeRows.filter((row) => row.month === selectedMonth);
    if (incomeSearchQuery.trim()) {
      const q = incomeSearchQuery.toLowerCase();
      rows = rows.filter((row) => 
        (row.room_number && row.room_number.toLowerCase().includes(q)) || 
        (row.tenant_name && row.tenant_name.toLowerCase().includes(q))
      );
    }
    if (incomeBuildingFilter !== "all") {
      rows = rows.filter(row => row.building_name === incomeBuildingFilter);
    }
    if (incomeStatusFilter !== "all") {
      rows = rows.filter(row => row.status === incomeStatusFilter);
    }
    if (incomePaymentMethodFilter !== "all") {
      rows = rows.filter(row => row.paymentMethod === incomePaymentMethodFilter);
    }
    return rows.sort((a, b) => {
      const dateA = new Date(a.issue_date || a.start_date || 0).getTime();
      const dateB = new Date(b.issue_date || b.start_date || 0).getTime();
      if (dateA !== dateB) return dateB - dateA;
      return byBuildingAndRoom(a, b);
    });
  }, [incomeRows, selectedMonth, incomeSearchQuery, incomeBuildingFilter, incomeStatusFilter, incomePaymentMethodFilter]);

  const incomeSummary = useMemo(() => {
    const billed = filteredIncomeRows.reduce((sum, row) => sum + row.total_amount, 0);
    const paid = filteredIncomeRows.reduce((sum, row) => sum + row.paid_amount, 0);
    const outstanding = filteredIncomeRows
      .filter((row) => ["pending", "partial", "overdue", "verifying"].includes(String(row.status)))
      .reduce((sum, row) => sum + Math.max(row.total_amount - row.paid_amount, 0), 0);
    return {
      billed,
      paid,
      outstanding,
      additional: filteredIncomeRows.reduce((sum, row) => sum + row.additional_fees_total, 0),
      electricityCollected: filteredIncomeRows.reduce((sum, row) => sum + row.electricity_bill, 0),
      waterCollected: filteredIncomeRows.reduce((sum, row) => sum + row.water_bill, 0),
    };
  }, [filteredIncomeRows]);

  const yearlyRows = useMemo(
    () =>
      Array.from({ length: 12 }, (_, index) => {
        const month = `${selectedYear}-${String(index + 1).padStart(2, "0")}`;
        const rows = incomeRows.filter((row) => row.month === month);
        const billed = rows.reduce((sum, row) => sum + row.total_amount, 0);
        const paid = rows.reduce((sum, row) => sum + row.paid_amount, 0);
        const outstanding = rows
          .filter((row) => ["pending", "partial", "overdue", "verifying"].includes(String(row.status)))
          .reduce((sum, row) => sum + Math.max(row.total_amount - row.paid_amount, 0), 0);
        return {
          month,
          invoiceCount: rows.length,
          billed,
          paid,
          outstanding,
          electricity: rows.reduce((sum, row) => sum + row.electricity_bill, 0),
          water: rows.reduce((sum, row) => sum + row.water_bill, 0),
          additional: rows.reduce((sum, row) => sum + row.additional_fees_total, 0),
        };
      }),
    [incomeRows, selectedYear]
  );

  const yearlySummary = useMemo(() => {
    const billed = yearlyRows.reduce((sum, row) => sum + row.billed, 0);
    const paid = yearlyRows.reduce((sum, row) => sum + row.paid, 0);
    const outstanding = yearlyRows.reduce((sum, row) => sum + row.outstanding, 0);
    return {
      billed,
      paid,
      outstanding,
      invoiceCount: yearlyRows.reduce((sum, row) => sum + row.invoiceCount, 0),
    };
  }, [yearlyRows]);

  const moveInRows = useMemo(() => {
    const direct = tenants
      .filter((row) => monthKey(String(row.move_in_date ?? "")) === selectedMonth)
      .map((row) => {
        const room = relationItem(row.rooms);
        return {
          date: row.move_in_date,
          room: room?.room_number ?? roomNumberById.get(String(row.room_id)) ?? "-",
          tenant: row.full_name,
          building: getBuildingName(room),
          deposit: toNumber(row.security_deposit_amount),
          advance: toNumber(row.advance_rent_amount),
        };
      });

    const seen = new Set(direct.map((row) => `${row.tenant}:${row.room}:${row.date}`));
    const history = logs
      .filter((row) => monthKey(String(row.move_in_date ?? "")) === selectedMonth)
      .map((row) => {
        const room = relationItem(row.rooms);
        return {
          date: row.move_in_date,
          room: room?.room_number ?? roomNumberById.get(String(row.room_id)) ?? "-",
          tenant: row.tenant_name,
          building: getBuildingName(room),
          deposit: 0,
          advance: 0,
        };
      })
      .filter((row) => !seen.has(`${row.tenant}:${row.room}:${row.date}`));

    return [...direct, ...history].sort((a, b) => {
      const dateA = new Date(a.date || 0).getTime();
      const dateB = new Date(b.date || 0).getTime();
      if (dateA !== dateB) return dateB - dateA;
      return byBuildingAndRoom(a, b);
    });
  }, [logs, roomNumberById, selectedMonth, tenants]);

  const moveInSummary = useMemo(
    () => ({
      count: moveInRows.length,
      deposit: moveInRows.reduce((sum, row) => sum + row.deposit, 0),
      advance: moveInRows.reduce((sum, row) => sum + row.advance, 0),
    }),
    [moveInRows]
  );

  const moveOutRows = useMemo(() => {
    const direct = tenants
      .filter((row) => monthKey(String(row.move_out_date ?? "")) === selectedMonth)
      .map((row) => {
        const settlement = settlementInvoiceByTenantId.get(String(row.id));

        if (settlement) {
          // Real figures from the final settlement invoice: discount_amount is the
          // deposit/advance credit actually applied (already zero if forfeited),
          // total_amount nets that against the final charges.
          const settlementRoom = relationItem(settlement.rooms);
          const prepaid = toNumber(settlement.discount_amount);
          const netAmount = toNumber(settlement.total_amount);
          const refunded = Math.max(0, -netAmount);
          const stillOwed = Math.max(0, netAmount);
          return {
            date: row.move_out_date,
            room:
              settlementRoom?.room_number ??
              roomByTenantId.get(String(row.id))?.room_number ??
              relationItem(row.rooms)?.room_number ??
              roomNumberById.get(String(row.room_id)) ??
              "-",
            tenant: row.full_name,
            building:
              (settlementRoom ? getBuildingName(settlementRoom) : null) ??
              roomByTenantId.get(String(row.id))?.building ??
              getBuildingName(relationItem(row.rooms)),
            prepaid,
            refunded,
            note:
              stillOwed > 0
                ? `จากใบแจ้งหนี้สรุปย้ายออก — ผู้เช่าค้างชำระเพิ่มเติม ${formatMoney(stillOwed)}`
                : "จากใบแจ้งหนี้สรุปย้ายออก",
          };
        }

        // No settlement invoice found (e.g. moved out via "abandon room" or a
        // manual date edit that skipped the settlement wizard) — fall back to the
        // tenant's raw deposit/advance fields as a rough estimate only.
        const room = relationItem(row.rooms);
        const prepaid = toNumber(row.security_deposit_amount) + toNumber(row.advance_rent_amount);
        return {
          date: row.move_out_date,
          room:
            room?.room_number ??
            roomByTenantId.get(String(row.id))?.room_number ??
            roomNumberById.get(String(row.room_id)) ??
            "-",
          tenant: row.full_name,
          building: getBuildingName(room) !== "-" ? getBuildingName(room) : (roomByTenantId.get(String(row.id))?.building ?? "-"),
          prepaid,
          refunded: prepaid,
          note: "ประมาณจากเงินประกัน + ค่าเช่าล่วงหน้าที่บันทึกไว้ (ไม่พบใบแจ้งหนี้สรุปย้ายออก)",
        };
      });

    const seen = new Set(direct.map((row) => `${row.tenant}:${row.room}:${row.date}`));
    const history = logs
      .filter((row) => monthKey(String(row.move_out_date ?? "")) === selectedMonth)
      .map((row) => {
        const room = relationItem(row.rooms);
        // The tenant record itself may be gone, but the settlement invoice (keyed
        // by tenant_id) can still carry the real refund figures.
        const settlement = settlementInvoiceByTenantId.get(String(row.tenant_id ?? ""));
        const prepaid = settlement ? toNumber(settlement.discount_amount) : 0;
        const netAmount = settlement ? toNumber(settlement.total_amount) : 0;
        const refunded = settlement ? Math.max(0, -netAmount) : 0;
        return {
          date: row.move_out_date,
          room: room?.room_number ?? roomNumberById.get(String(row.room_id)) ?? "-",
          tenant: row.tenant_name,
          building: getBuildingName(room),
          prepaid,
          refunded,
          note: settlement ? "จากใบแจ้งหนี้สรุปย้ายออก" : "มีเฉพาะประวัติการย้ายออก",
        };
      })
      .filter((row) => !seen.has(`${row.tenant}:${row.room}:${row.date}`));

    return [...direct, ...history].sort((a, b) => {
      const dateA = new Date(a.date || 0).getTime();
      const dateB = new Date(b.date || 0).getTime();
      if (dateA !== dateB) return dateB - dateA;
      return byBuildingAndRoom(a, b);
    });
  }, [logs, roomNumberById, roomByTenantId, settlementInvoiceByTenantId, selectedMonth, tenants]);

  const moveOutSummary = useMemo(
    () => ({
      count: moveOutRows.length,
      prepaid: moveOutRows.reduce((sum, row) => sum + row.prepaid, 0),
      refunded: moveOutRows.reduce((sum, row) => sum + row.refunded, 0),
    }),
    [moveOutRows]
  );

  const utilityRoomRows = useMemo(
    () => {
      const paidInvoiceKeys = new Set(
        incomeRows
          .filter((row) => row.status === "paid")
          .map((row) => `${row.room_id}:${row.month}`)
      );

      return meters
        .filter((row) => paidInvoiceKeys.has(`${row.room_id}:${monthKey(row.reading_month)}`))
        .map((row) => {
        const room = relationItem(row.rooms);
        const electricityUsage = toNumber(row.electricity_usage);
        const waterUsage = toNumber(row.water_usage);
        return {
          month: monthKey(row.reading_month),
          room: room?.room_number ?? roomNumberById.get(String(row.room_id)) ?? "-",
          building: getBuildingName(room),
          electricityUsage,
          waterUsage,
          electricityAmount: electricityUsage * settings.electricity_rate,
          waterAmount: waterUsage * settings.water_rate,
        };
      });
    },
    [incomeRows, meters, roomNumberById, settings.electricity_rate, settings.water_rate]
  );

  const utilityMonthlyRows = useMemo(
    () =>
      Array.from({ length: 12 }, (_, index) => {
        const month = `${selectedYear}-${String(index + 1).padStart(2, "0")}`;
        const rows = utilityRoomRows.filter((row) => row.month === month);
        const electricityAmount = rows.reduce((sum, row) => sum + row.electricityAmount, 0);
        const waterAmount = rows.reduce((sum, row) => sum + row.waterAmount, 0);
        return {
          month,
          electricityUsage: rows.reduce((sum, row) => sum + row.electricityUsage, 0),
          waterUsage: rows.reduce((sum, row) => sum + row.waterUsage, 0),
          electricityAmount,
          waterAmount,
          total: electricityAmount + waterAmount,
        };
      }),
    [selectedYear, utilityRoomRows]
  );

  const utilitySummary = useMemo(
    () => ({
      electricityUsage: utilityMonthlyRows.reduce((sum, row) => sum + row.electricityUsage, 0),
      waterUsage: utilityMonthlyRows.reduce((sum, row) => sum + row.waterUsage, 0),
      electricityAmount: utilityMonthlyRows.reduce((sum, row) => sum + row.electricityAmount, 0),
      waterAmount: utilityMonthlyRows.reduce((sum, row) => sum + row.waterAmount, 0),
      total: utilityMonthlyRows.reduce((sum, row) => sum + row.total, 0),
    }),
    [utilityMonthlyRows]
  );

  const movementRows = useMemo(() => {
    const logRows = logs.flatMap((row) => {
      const room = relationItem(row.rooms);
      const roomText = room?.room_number ?? roomNumberById.get(String(row.room_id)) ?? "-";
      const entries = [
        {
          date: row.move_in_date,
          type: "ย้ายเข้า",
          tenant: row.tenant_name,
          building: getBuildingName(room),
          room: roomText,
          details: "เริ่มเข้าพัก",
        },
      ];
      if (row.move_out_date) {
        entries.push({
          date: row.move_out_date,
          type: "ย้ายออก",
          tenant: row.tenant_name,
          building: getBuildingName(room),
          room: roomText,
          details: "สิ้นสุดการพัก",
        });
      }
      return entries;
    });

    const transferRows = transfers.map((row) => ({
      date: row.transfer_date,
      type: "ย้ายห้อง",
      tenant: tenants.find((tenant) => tenant.id === row.tenant_id)?.full_name ?? row.tenant_id,
      building: `${roomNumberById.get(String(row.from_room_id)) ? "ดูห้องต้นทาง/ปลายทาง" : "-"}`,
      room: `${roomNumberById.get(String(row.from_room_id)) ?? row.from_room_id} -> ${
        roomNumberById.get(String(row.to_room_id)) ?? row.to_room_id
      }`,
      details: `ค่าเช่าห้องเดิม ${formatMoney(toNumber(row.old_rent_amount))} | ค่าเช่าห้องใหม่ ${formatMoney(
        toNumber(row.new_rent_amount)
      )}`,
    }));

    return [...logRows, ...transferRows]
      .filter((row) => String(row.date ?? "").startsWith(String(selectedYear)))
      .sort((a, b) => {
        const groupOrder = byBuildingAndRoom(a, b);
        if (groupOrder !== 0) return groupOrder;
        return String(a.date).localeCompare(String(b.date));
      });
  }, [logs, roomNumberById, selectedYear, tenants, transfers]);

  const movementSummary = useMemo(
    () => ({
      total: movementRows.length,
      moveIn: movementRows.filter((row) => row.type === "ย้ายเข้า").length,
      moveOut: movementRows.filter((row) => row.type === "ย้ายออก").length,
      transfer: movementRows.filter((row) => row.type === "ย้ายห้อง").length,
    }),
    [movementRows]
  );

  const filteredMovementRows = useMemo(() => {
    let rows = movementRows;
    if (movementTypeFilter !== "all") {
      rows = rows.filter((row) => row.type === movementTypeFilter);
    }
    if (movementSearchQuery.trim()) {
      const q = movementSearchQuery.toLowerCase();
      rows = rows.filter((row) => 
        (row.room && row.room.toLowerCase().includes(q)) || 
        (row.tenant && row.tenant.toLowerCase().includes(q))
      );
    }
    return rows;
  }, [movementRows, movementTypeFilter, movementSearchQuery]);

  
  const arrearsRows = useMemo(() => {
    const tenantDebts = new Map<string, any>();
    for (const invoice of invoices) {
      if (["pending", "partial", "overdue", "verifying"].includes(String(invoice.status))) {
        const outstanding = invoice.total_amount - invoice.paid_amount;
        if (outstanding > 0) {
          const tenantId = invoice.tenant_id || invoice.tenant_name || "unknown";
          if (!tenantDebts.has(tenantId)) {
            tenantDebts.set(tenantId, {
              tenant_name: invoice.tenant_name,
              room_number: invoice.room_number,
              building_name: invoice.building_name,
              outstanding: 0,
              invoice_count: 0,
              oldest_due_date: invoice.due_date
            });
          }
          const data = tenantDebts.get(tenantId)!;
          data.outstanding += outstanding;
          data.invoice_count += 1;
          if (invoice.due_date && (!data.oldest_due_date || new Date(invoice.due_date) < new Date(data.oldest_due_date))) {
            data.oldest_due_date = invoice.due_date;
          }
        }
      }
    }
    return Array.from(tenantDebts.values()).sort((a, b) => b.outstanding - a.outstanding);
  }, [invoices]);

  const arrearsSummary = useMemo(() => ({
    total_outstanding: arrearsRows.reduce((sum, row) => sum + row.outstanding, 0),
    total_tenants: arrearsRows.length,
    total_invoices: arrearsRows.reduce((sum, row) => sum + row.invoice_count, 0)
  }), [arrearsRows]);

  const exportArrears = () =>
    downloadCsv(
      `arrears-report.csv`,
      ["อาคาร", "ห้อง", "ชื่อผู้เช่า", "จำนวนบิลที่ค้าง", "วันที่ค้างนานสุด", "ยอดค้างรวม"],
      arrearsRows.map((row) => [row.building_name, row.room_number, row.tenant_name, row.invoice_count, formatDate(row.oldest_due_date), row.outstanding])
    );

  const exportIncome = () =>
    downloadCsv(
      `income-report-${selectedMonth}.csv`,
      ["เดือน", "อาคาร", "เลขห้อง", "ชื่อผู้เช่า", "หน่วยไฟ", "ค่าไฟ", "หน่วยน้ำ", "ค่าน้ำ", "ยอดเรียกเก็บ", "ยอดที่ชำระ", "วิธีชำระ", "สถานะ", "ค่าธรรมเนียมเพิ่มเติม"],
      filteredIncomeRows.map((row) => [
        row.month,
        row.building_name,
        row.room_number,
        row.tenant_name,
        row.electricityUsage,
        row.electricity_bill,
        row.waterUsage,
        row.water_bill,
        row.total_amount,
        row.paid_amount,
        row.paymentMethod,
        statusLabel(row.status),
        row.additionalFeeText,
      ])
    );

  const exportMoveIn = () =>
    downloadCsv(
      `move-in-report-${selectedMonth}.csv`,
      ["วันที่", "เลขห้อง", "ชื่อผู้เช่า", "อาคาร", "เงินประกัน", "ค่าเช่าล่วงหน้า"],
      moveInRows.map((row) => [row.date, row.room, row.tenant, row.building, row.deposit, row.advance])
    );

  const exportMoveOut = () =>
    downloadCsv(
      `move-out-report-${selectedMonth}.csv`,
      ["วันที่", "เลขห้อง", "ชื่อผู้เช่า", "อาคาร", "ยอดล่วงหน้า", "ยอดคืน", "หมายเหตุ"],
      moveOutRows.map((row) => [row.date ?? "-", row.room, row.tenant, row.building, row.prepaid, row.refunded, row.note])
    );

  const exportYearly = () =>
    downloadCsv(
      `year-summary-${selectedYear}.csv`,
      ["เดือน", "จำนวนบิล", "ยอดเรียกเก็บ", "ยอดชำระ", "ยอดค้าง", "ค่าไฟ", "ค่าน้ำ", "ค่าธรรมเนียมเพิ่ม"],
      yearlyRows.map((row) => [
        row.month,
        row.invoiceCount,
        row.billed,
        row.paid,
        row.outstanding,
        row.electricity,
        row.water,
        row.additional,
      ])
    );

  const exportUtilities = () =>
    downloadCsv(
      `utilities-report-${selectedYear}.csv`,
      ["เดือน", "หน่วยไฟ", "ยอดค่าไฟ", "หน่วยน้ำ", "ยอดค่าน้ำ", "รวม"],
      utilityMonthlyRows.map((row) => [
        row.month,
        row.electricityUsage,
        row.electricityAmount,
        row.waterUsage,
        row.waterAmount,
        row.total,
      ])
    );

  const exportMovement = () =>
    downloadCsv(
      `movement-report-${selectedYear}.csv`,
      ["วันที่", "ประเภท", "อาคาร", "ชื่อผู้เช่า", "ห้อง", "รายละเอียด"],
      movementRows.map((row) => [row.date, row.type, row.building ?? "-", row.tenant, row.room, row.details])
    );

  const exportAll = () => {
    exportIncome();
    setTimeout(exportMoveIn, 120);
    setTimeout(exportMoveOut, 240);
    setTimeout(exportYearly, 360);
    setTimeout(exportUtilities, 480);
    setTimeout(exportMovement, 600);
  };

  if (permissionLoading || loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center gap-3 rounded-card border border-slate-200 bg-white">
        <Loader2 className="animate-spin text-primary-600" size={18} />
        <span className="text-sm text-slate-600">กำลังโหลดรายงาน...</span>
      </div>
    );
  }

  if (!canViewReports) {
    return (
      <div className="rounded-card border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-800">
        คุณไม่มีสิทธิ์ดูหน้ารายงาน
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-500">หน้ารายงานสำหรับส่งบัญชี</p>
              <h2 className="text-2xl font-semibold text-slate-900">รายงานประจำปี</h2>
              <p className="max-w-3xl text-sm text-slate-600">
                แยกรายงานเป็นแท็บตามงานจริง เพื่อให้แอดมินเปิดดูเฉพาะรายงานที่ต้องใช้ และดาวน์โหลดเป็นไฟล์สเปรดชีตได้ทันที
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1 text-sm text-slate-600">
                <span className="block font-medium">ปี</span>
                <input
                  type="number"
                  value={selectedYear}
                  onChange={(event) => setSelectedYear(Math.max(2000, toNumber(event.target.value)))}
                  className="w-32 rounded-control border border-slate-200 px-3 py-2 text-slate-900"
                />
              </label>
              <button
                onClick={exportAll}
                className={buttonClasses({ variant: "primary" })}
              >
                <FileSpreadsheet size={16} />
                ดาวน์โหลดทุกไฟล์
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 rounded-card bg-slate-100 p-2">
            <TabButton active={activeTab === "income"} onClick={() => setActiveTab("income")} label="รายได้รายเดือน" />
            <TabButton active={activeTab === "arrears"} onClick={() => setActiveTab("arrears")} label="ยอดค้างชำระ (ลูกหนี้)" />
            <TabButton active={activeTab === "move_in"} onClick={() => setActiveTab("move_in")} label="ย้ายเข้า" />
            <TabButton active={activeTab === "move_out"} onClick={() => setActiveTab("move_out")} label="ย้ายออก" />
            <TabButton active={activeTab === "yearly"} onClick={() => setActiveTab("yearly")} label="สรุปทั้งปี" />
            <TabButton active={activeTab === "utilities"} onClick={() => setActiveTab("utilities")} label="ค่าน้ำค่าไฟ" />
            <TabButton active={activeTab === "movement"} onClick={() => setActiveTab("movement")} label="การเคลื่อนไหวห้อง" />
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-card border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700">
          {error}
        </div>
      )}

      {activeTab === "income" && (
        <>
          <Card>
            <CardContent className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">รายงานรายได้รายเดือน</h3>
                <p className="text-sm text-slate-500">เลือกเดือนที่ต้องการดู แล้วส่งออกเฉพาะเดือนนั้นได้</p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                  <input
                    type="text"
                    placeholder="ค้นหาห้อง / ผู้เช่า..."
                    value={incomeSearchQuery}
                    onChange={(e) => setIncomeSearchQuery(e.target.value)}
                    className="h-[38px] w-48 rounded-control border border-slate-200 pl-9 pr-3 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                  />
                </div>
                {incomeBuildingOptions.length > 0 && (
                  <select
                    value={incomeBuildingFilter}
                    onChange={(e) => setIncomeBuildingFilter(e.target.value)}
                    className="h-[38px] rounded-control border border-slate-200 px-3 py-1 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-primary-500"
                  >
                    <option value="all">ทุกอาคาร</option>
                    {incomeBuildingOptions.map(b => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                )}
                <select
                  value={incomeStatusFilter}
                  onChange={(e) => setIncomeStatusFilter(e.target.value)}
                  className="h-[38px] rounded-control border border-slate-200 px-3 py-1 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-primary-500"
                >
                  <option value="all">ทุกสถานะ</option>
                  <option value="paid">ชำระแล้ว (Paid)</option>
                  <option value="pending">รอชำระ (Pending)</option>
                  <option value="partial">จ่ายบางส่วน (Partial)</option>
                  <option value="overdue">ค้างชำระ (Overdue)</option>
                  <option value="verifying">รอตรวจสอบ (Verifying)</option>
                </select>
                {incomePaymentMethodOptions.length > 0 && (
                  <select
                    value={incomePaymentMethodFilter}
                    onChange={(e) => setIncomePaymentMethodFilter(e.target.value)}
                    className="h-[38px] rounded-control border border-slate-200 px-3 py-1 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-primary-500"
                  >
                    <option value="all">ทุกวิธีชำระ</option>
                    {incomePaymentMethodOptions.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                )}
                <label className="space-y-1 text-sm text-slate-600">
                  <input
                    type="month"
                    value={selectedMonth}
                    onChange={(event) => setSelectedMonth(event.target.value)}
                    className="h-[38px] rounded-control border border-slate-200 px-3 py-2 text-slate-900"
                  />
                </label>
                <ExportButton onClick={exportIncome} />
              </div>
            </CardContent>
          </Card>
          <SummaryCards
            items={[
              { label: "ยอดเรียกเก็บ", value: formatMoney(incomeSummary.billed) },
              { label: "ยอดชำระ", value: formatMoney(incomeSummary.paid) },
              { label: "ยอดค้าง", value: formatMoney(incomeSummary.outstanding) },
              { label: "ค่าธรรมเนียมเพิ่ม", value: formatMoney(incomeSummary.additional) },
              { label: "ค่าไฟ", value: formatMoney(incomeSummary.electricityCollected) },
              { label: "ค่าน้ำ", value: formatMoney(incomeSummary.waterCollected) },
            ]}
          />
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto rounded-control">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-3 py-2">อาคาร</th>
                      <th className="px-3 py-2">เลขห้อง</th>
                      <th className="px-3 py-2">ชื่อผู้เช่า</th>
                      <th className="px-3 py-2 text-right">ยอดเรียกเก็บ</th>
                      <th className="px-3 py-2 text-right">ยอดชำระ</th>
                      <th className="px-3 py-2 text-center">วิธีชำระ</th>
                      <th className="px-3 py-2 text-center">สถานะ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredIncomeRows.length > 0 ? (
                      filteredIncomeRows.map((row) => (
                        <tr 
                          key={row.id} 
                          className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                          onClick={() => setSelectedIncomeInvoice(row)}
                        >
                          <td className="px-3 py-2">{row.building_name}</td>
                          <td className="px-3 py-2 font-medium">{row.room_number}</td>
                          <td className="px-3 py-2">{row.tenant_name}</td>
                          <td className="px-3 py-2 text-right">{formatMoney(row.total_amount)}</td>
                          <td className="px-3 py-2 text-right text-success-600">{formatMoney(row.paid_amount)}</td>
                          <td className="px-3 py-2 text-center">{row.paymentMethod}</td>
                          <td className="px-3 py-2 text-center">
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-2xs">{statusLabel(row.status)}</span>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                          ไม่พบข้อมูลรายได้
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
          
          <Modal
            isOpen={!!selectedIncomeInvoice}
            onClose={() => setSelectedIncomeInvoice(null)}
            title="รายละเอียดบิล"
            size="lg"
          >
            {selectedIncomeInvoice && (
              <div className="space-y-4 text-sm">
                <div className="flex justify-between rounded-control bg-slate-50 p-4 border border-slate-100">
                  <div>
                    <p className="font-semibold text-slate-900">ห้อง {selectedIncomeInvoice.room_number}</p>
                    <p className="text-slate-500">{selectedIncomeInvoice.tenant_name}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-slate-900">{formatMoney(selectedIncomeInvoice.total_amount)}</p>
                    <p className="text-slate-500">สถานะ: {statusLabel(selectedIncomeInvoice.status)}</p>
                  </div>
                </div>
                
                <table className="w-full text-sm border-collapse">
                  <thead className="bg-slate-50 text-slate-600 border border-slate-100">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium border-b border-slate-100">รายการ</th>
                      <th className="px-3 py-2 text-right font-medium border-b border-slate-100">จำนวนเงิน</th>
                    </tr>
                  </thead>
                  <tbody className="border border-slate-100">
                    <tr className="border-b border-slate-100">
                      <td className="px-3 py-2">ค่าเช่า</td>
                      <td className="px-3 py-2 text-right">{formatMoney(selectedIncomeInvoice.rent_amount)}</td>
                    </tr>
                    <tr className="border-b border-slate-100">
                      <td className="px-3 py-2">ค่าน้ำ ({selectedIncomeInvoice.waterUsage} หน่วย)</td>
                      <td className="px-3 py-2 text-right">{formatMoney(selectedIncomeInvoice.water_bill)}</td>
                    </tr>
                    <tr className="border-b border-slate-100">
                      <td className="px-3 py-2">ค่าไฟ ({selectedIncomeInvoice.electricityUsage} หน่วย)</td>
                      <td className="px-3 py-2 text-right">{formatMoney(selectedIncomeInvoice.electricity_bill)}</td>
                    </tr>
                    {selectedIncomeInvoice.common_fee > 0 && (
                      <tr className="border-b border-slate-100">
                        <td className="px-3 py-2">ค่าส่วนกลาง</td>
                        <td className="px-3 py-2 text-right">{formatMoney(selectedIncomeInvoice.common_fee)}</td>
                      </tr>
                    )}
                    {selectedIncomeInvoice.late_fee_amount > 0 && (
                      <tr className="border-b border-slate-100">
                        <td className="px-3 py-2">ค่าปรับล่าช้า</td>
                        <td className="px-3 py-2 text-right">{formatMoney(selectedIncomeInvoice.late_fee_amount)}</td>
                      </tr>
                    )}
                    {Array.isArray(selectedIncomeInvoice.additional_fees_breakdown) && selectedIncomeInvoice.additional_fees_breakdown.map((fee: any, idx: number) => (
                      <tr key={idx} className="border-b border-slate-100">
                        <td className="px-3 py-2">ค่าอื่นๆ ({fee.detail || fee.label || '-'})</td>
                        <td className="px-3 py-2 text-right">{formatMoney(fee.amount || fee.total_amount)}</td>
                      </tr>
                    ))}
                    {selectedIncomeInvoice.discount_amount > 0 && (
                      <tr className="border-b border-slate-100 text-success-600">
                        <td className="px-3 py-2">ส่วนลด</td>
                        <td className="px-3 py-2 text-right">-{formatMoney(selectedIncomeInvoice.discount_amount)}</td>
                      </tr>
                    )}
                    <tr className="bg-slate-50 font-semibold">
                      <td className="px-3 py-3 text-right">รวมสุทธิ</td>
                      <td className="px-3 py-3 text-right">{formatMoney(selectedIncomeInvoice.total_amount)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Modal>
        </>
      )}

      
      {activeTab === "arrears" && (
        <>
          <Card>
            <CardContent className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">รายงานยอดค้างชำระ (ลูกหนี้)</h3>
                <p className="text-sm text-slate-500">รวมยอดผู้เช่าที่มียอดค้างชำระ เรียงจากค้างมากที่สุด</p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <ExportButton onClick={exportArrears} />
              </div>
            </CardContent>
          </Card>
          <SummaryCards
            items={[
              { label: "จำนวนผู้เช่าที่ค้างชำระ", value: arrearsSummary.total_tenants.toLocaleString("th-TH") + " คน" },
              { label: "จำนวนบิลที่ค้างรวม", value: arrearsSummary.total_invoices.toLocaleString("th-TH") + " ใบ" },
              { label: "ยอดค้างรวมทั้งหมด", value: formatMoney(arrearsSummary.total_outstanding) },
            ]}
          />
          <ReportTable
            headers={["อาคาร", "ห้อง", "ชื่อผู้เช่า", "จำนวนบิลที่ค้าง", "เริ่มค้างตั้งแต่", "ยอดค้างรวม"]}
            rows={arrearsRows.map((row) => [
              row.building_name,
              row.room_number,
              row.tenant_name,
              row.invoice_count.toLocaleString("th-TH"),
              formatDate(row.oldest_due_date),
              formatMoney(row.outstanding),
            ])}
            emptyText="ไม่มีผู้เช่าที่ค้างชำระ"
          />
        </>
      )}

      {activeTab === "move_in" && (
        <>
          <Card>
            <CardContent className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">รายงานย้ายเข้า</h3>
                <p className="text-sm text-slate-500">เลือกเดือนที่ต้องการดูรายการย้ายเข้า</p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1 text-sm text-slate-600">
                  <span className="block font-medium">เดือน</span>
                  <input
                    type="month"
                    value={selectedMonth}
                    onChange={(event) => setSelectedMonth(event.target.value)}
                    className="rounded-control border border-slate-200 px-3 py-2 text-slate-900"
                  />
                </label>
              </div>
            </CardContent>
          </Card>
          <SummaryCards
            items={[
              { label: "จำนวนรายการย้ายเข้า", value: moveInSummary.count.toLocaleString("th-TH") },
              { label: "รวมเงินประกัน", value: formatMoney(moveInSummary.deposit) },
              { label: "รวมค่าเช่าล่วงหน้า", value: formatMoney(moveInSummary.advance) },
            ]}
          />
          <Card>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">รายงานย้ายเข้า</h3>
                  <p className="text-sm text-slate-500">แสดงเฉพาะห้องที่มีการย้ายเข้าในปีที่เลือก</p>
                </div>
                <ExportButton onClick={exportMoveIn} />
              </div>
              <ReportTable
                headers={["อาคาร", "เลขห้อง", "วันที่", "ชื่อผู้เช่า", "เงินประกัน", "ค่าเช่าล่วงหน้า"]}
                rows={moveInRows.map((row) => [
                  row.building,
                  row.room,
                  formatDate(row.date),
                  row.tenant,
                  formatMoney(row.deposit),
                  formatMoney(row.advance),
                ])}
                emptyText={`ไม่มีข้อมูลย้ายเข้าในเดือน ${selectedMonth}`}
                embedded
              />
            </CardContent>
          </Card>
        </>
      )}

      {activeTab === "move_out" && (
        <>
          <Card>
            <CardContent className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">รายงานย้ายออก</h3>
                <p className="text-sm text-slate-500">เลือกเดือนที่ต้องการดูรายการย้ายออก</p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1 text-sm text-slate-600">
                  <span className="block font-medium">เดือน</span>
                  <input
                    type="month"
                    value={selectedMonth}
                    onChange={(event) => setSelectedMonth(event.target.value)}
                    className="rounded-control border border-slate-200 px-3 py-2 text-slate-900"
                  />
                </label>
              </div>
            </CardContent>
          </Card>
          <SummaryCards
            items={[
              { label: "จำนวนรายการย้ายออก", value: moveOutSummary.count.toLocaleString("th-TH") },
              { label: "ยอดล่วงหน้ารวม", value: formatMoney(moveOutSummary.prepaid) },
              { label: "ยอดคืนรวม", value: formatMoney(moveOutSummary.refunded) },
            ]}
          />
          <Card>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">รายงานย้ายออก</h3>
                  <p className="text-sm text-slate-500">แสดงเฉพาะห้องที่มีการย้ายออกในปีที่เลือก</p>
                </div>
                <ExportButton onClick={exportMoveOut} />
              </div>
              <ReportTable
                headers={["อาคาร", "เลขห้อง", "วันที่", "ชื่อผู้เช่า", "ยอดล่วงหน้า", "ยอดคืน", "หมายเหตุ"]}
                rows={moveOutRows.map((row) => [
                  row.building,
                  row.room,
                  formatDate(row.date),
                  row.tenant,
                  formatMoney(row.prepaid),
                  formatMoney(row.refunded),
                  row.note,
                ])}
                emptyText={`ไม่มีข้อมูลย้ายออกในเดือน ${selectedMonth}`}
                embedded
              />
            </CardContent>
          </Card>
        </>
      )}

      {activeTab === "yearly" && (
        <>
          <SummaryCards
            items={[
              { label: "จำนวนบิลทั้งปี", value: yearlySummary.invoiceCount.toLocaleString("th-TH") },
              { label: "ยอดเรียกเก็บทั้งปี", value: formatMoney(yearlySummary.billed) },
              { label: "ยอดชำระทั้งปี", value: formatMoney(yearlySummary.paid) },
              { label: "ยอดค้างทั้งปี", value: formatMoney(yearlySummary.outstanding) },
            ]}
          />
          <Card>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">สรุปรายงานทั้งปี</h3>
                  <p className="text-sm text-slate-500">รวมยอดของทุกเดือนในปีที่เลือก</p>
                </div>
                <ExportButton onClick={exportYearly} />
              </div>
              <ReportTable
                headers={["เดือน", "จำนวนบิล", "ยอดเรียกเก็บ", "ยอดชำระ", "ยอดค้าง", "ค่าไฟ", "ค่าน้ำ", "ค่าธรรมเนียมเพิ่ม"]}
                rows={yearlyRows.map((row) => [
                  row.month,
                  row.invoiceCount.toLocaleString("th-TH"),
                  formatMoney(row.billed),
                  formatMoney(row.paid),
                  formatMoney(row.outstanding),
                  formatMoney(row.electricity),
                  formatMoney(row.water),
                  formatMoney(row.additional),
                ])}
                emptyText="ไม่มีข้อมูลสรุปรายปี"
                embedded
              />
            </CardContent>
          </Card>
        </>
      )}

      {activeTab === "utilities" && (
        <>
          <SummaryCards
            items={[
              { label: "หน่วยไฟรวม", value: utilitySummary.electricityUsage.toLocaleString("th-TH") },
              { label: "ยอดค่าไฟรวม", value: formatMoney(utilitySummary.electricityAmount) },
              { label: "หน่วยน้ำรวม", value: utilitySummary.waterUsage.toLocaleString("th-TH") },
              { label: "ยอดค่าน้ำรวม", value: formatMoney(utilitySummary.waterAmount) },
              { label: "รวมค่าน้ำค่าไฟ", value: formatMoney(utilitySummary.total) },
            ]}
          />
          <Card>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">รายงานค่าน้ำและค่าไฟ</h3>
                  <p className="text-sm text-slate-500">สรุปเป็นยอดเงินแยกตามเดือนตามที่ใช้ส่งบัญชี</p>
                </div>
                <ExportButton onClick={exportUtilities} />
              </div>
              <ReportTable
                headers={["เดือน", "หน่วยไฟ", "ยอดค่าไฟ", "หน่วยน้ำ", "ยอดค่าน้ำ", "รวม"]}
                rows={utilityMonthlyRows.map((row) => [
                  row.month,
                  row.electricityUsage.toLocaleString("th-TH"),
                  formatMoney(row.electricityAmount),
                  row.waterUsage.toLocaleString("th-TH"),
                  formatMoney(row.waterAmount),
                  formatMoney(row.total),
                ])}
                emptyText="ไม่มีข้อมูลค่าน้ำค่าไฟ"
                embedded
              />
            </CardContent>
          </Card>
        </>
      )}

      {activeTab === "movement" && (
        <>
          <SummaryCards
            items={[
              { label: "รายการเคลื่อนไหวทั้งหมด", value: movementSummary.total.toLocaleString("th-TH") },
              { label: "ย้ายเข้า", value: movementSummary.moveIn.toLocaleString("th-TH") },
              { label: "ย้ายออก", value: movementSummary.moveOut.toLocaleString("th-TH") },
              { label: "ย้ายห้อง", value: movementSummary.transfer.toLocaleString("th-TH") },
            ]}
          />
          <Card>
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">รายงานการเคลื่อนไหวห้องและผู้เช่า</h3>
                  <p className="text-sm text-slate-500">ดูว่าห้องไหนมีการย้ายเข้า ย้ายออก หรือย้ายห้องเมื่อใด</p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                    <input
                      type="text"
                      placeholder="ค้นหาห้อง / ผู้เช่า..."
                      value={movementSearchQuery}
                      onChange={(e) => setMovementSearchQuery(e.target.value)}
                      className="h-[38px] w-48 rounded-control border border-slate-200 pl-9 pr-3 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                    />
                  </div>
                  <select
                    value={movementTypeFilter}
                    onChange={(e) => setMovementTypeFilter(e.target.value)}
                    className="h-[38px] rounded-control border border-slate-200 px-3 py-1 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-primary-500"
                  >
                    <option value="all">ทุกประเภท</option>
                    <option value="ย้ายเข้า">ย้ายเข้า</option>
                    <option value="ย้ายออก">ย้ายออก</option>
                    <option value="ย้ายห้อง">ย้ายห้อง</option>
                  </select>
                  <ExportButton onClick={exportMovement} />
                </div>
              </div>
              <ReportTable
                headers={["อาคาร", "ห้อง", "วันที่", "ประเภท", "ชื่อผู้เช่า", "รายละเอียด"]}
                rows={filteredMovementRows.map((row) => [
                  row.building ?? "-",
                  row.room,
                  formatDate(row.date),
                  row.type,
                  row.tenant,
                  row.details,
                ])}
                emptyText="ไม่มีข้อมูลการเคลื่อนไหว"
                embedded
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-control px-4 py-2.5 text-sm font-semibold transition ${
        active ? "bg-white text-primary-700 shadow-sm" : "text-slate-600 hover:bg-white/70"
      }`}
    >
      {label}
    </button>
  );
}

function ExportButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={buttonClasses({ variant: "secondary" })}
    >
      <Download size={16} />
      ดาวน์โหลดสเปรดชีต
    </button>
  );
}

function SummaryCards({
  items,
}: {
  items: { label: string; value: string }[];
}) {
  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label}>
          <CardContent className="space-y-1">
            <p className="text-sm text-slate-500">{item.label}</p>
            <p className="text-2xl font-semibold text-slate-900">{item.value}</p>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

function ReportTable({
  headers,
  rows,
  emptyText,
  embedded = false,
}: {
  headers: string[];
  rows: Array<Array<string | number>>;
  emptyText: string;
  embedded?: boolean;
}) {
  const table = (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            {headers.map((header) => (
              <th key={header} className="px-3 py-2">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length > 0 ? (
            rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t border-slate-100 align-top">
                {row.map((cell, cellIndex) => (
                  <td key={`${rowIndex}-${cellIndex}`} className="px-3 py-2">
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={headers.length} className="px-3 py-6 text-center text-slate-500">
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  if (embedded) return table;

  return (
    <Card>
      <CardContent>{table}</CardContent>
    </Card>
  );
}
