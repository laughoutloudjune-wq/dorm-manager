"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FileSpreadsheet, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";

type ReportTab = "income" | "move_in" | "move_out" | "yearly" | "utilities" | "movement";

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
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState({ water_rate: 0, electricity_rate: 0 });
  const [invoices, setInvoices] = useState<any[]>([]);
  const [tenants, setTenants] = useState<any[]>([]);
  const [meters, setMeters] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [transfers, setTransfers] = useState<any[]>([]);

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
      const [settingsRes, invoicesRes, tenantsRes, metersRes, logsRes, transfersRes] = await Promise.all([
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
      ]);

      if (!mounted) return;
      const firstError =
        settingsRes.error ||
        invoicesRes.error ||
        tenantsRes.error ||
        metersRes.error ||
        logsRes.error ||
        transfersRes.error;

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

  const filteredIncomeRows = useMemo(
    () => incomeRows.filter((row) => row.month === selectedMonth).sort(byBuildingAndRoom),
    [incomeRows, selectedMonth]
  );

  const incomeSummary = useMemo(() => {
    const billed = filteredIncomeRows.reduce((sum, row) => sum + row.total_amount, 0);
    const paid = filteredIncomeRows.reduce((sum, row) => sum + row.paid_amount, 0);
    return {
      billed,
      paid,
      outstanding: Math.max(billed - paid, 0),
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
        return {
          month,
          invoiceCount: rows.length,
          billed,
          paid,
          outstanding: Math.max(billed - paid, 0),
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
    return {
      billed,
      paid,
      outstanding: Math.max(billed - paid, 0),
      invoiceCount: yearlyRows.reduce((sum, row) => sum + row.invoiceCount, 0),
    };
  }, [yearlyRows]);

  const moveInRows = useMemo(() => {
    const direct = tenants
      .filter((row) => String(row.move_in_date ?? "").startsWith(String(selectedYear)))
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
      .filter((row) => String(row.move_in_date ?? "").startsWith(String(selectedYear)))
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

    return [...direct, ...history].sort(byBuildingAndRoom);
  }, [logs, roomNumberById, selectedYear, tenants]);

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
      .filter((row) => String(row.move_out_date ?? "").startsWith(String(selectedYear)))
      .map((row) => {
        const room = relationItem(row.rooms);
        const prepaid = toNumber(row.security_deposit_amount) + toNumber(row.advance_rent_amount);
        return {
          date: row.move_out_date,
          room: room?.room_number ?? roomNumberById.get(String(row.room_id)) ?? "-",
          tenant: row.full_name,
          building: getBuildingName(room),
          prepaid,
          refunded: prepaid,
          note: "ประมาณจากเงินประกัน + ค่าเช่าล่วงหน้าที่บันทึกไว้",
        };
      });

    const seen = new Set(direct.map((row) => `${row.tenant}:${row.room}:${row.date}`));
    const history = logs
      .filter((row) => String(row.move_out_date ?? "").startsWith(String(selectedYear)))
      .map((row) => {
        const room = relationItem(row.rooms);
        return {
          date: row.move_out_date,
          room: room?.room_number ?? roomNumberById.get(String(row.room_id)) ?? "-",
          tenant: row.tenant_name,
          building: getBuildingName(room),
          prepaid: 0,
          refunded: 0,
          note: "มีเฉพาะประวัติการย้ายออก",
        };
      })
      .filter((row) => !seen.has(`${row.tenant}:${row.room}:${row.date}`));

    return [...direct, ...history].sort(byBuildingAndRoom);
  }, [logs, roomNumberById, selectedYear, tenants]);

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
      `move-in-report-${selectedYear}.csv`,
      ["วันที่", "เลขห้อง", "ชื่อผู้เช่า", "อาคาร", "เงินประกัน", "ค่าเช่าล่วงหน้า"],
      moveInRows.map((row) => [row.date, row.room, row.tenant, row.building, row.deposit, row.advance])
    );

  const exportMoveOut = () =>
    downloadCsv(
      `move-out-report-${selectedYear}.csv`,
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
      <div className="flex min-h-[40vh] items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white">
        <Loader2 className="animate-spin text-blue-600" size={18} />
        <span className="text-sm text-slate-600">กำลังโหลดรายงาน...</span>
      </div>
    );
  }

  if (!canViewReports) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
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
                  className="w-32 rounded-xl border border-slate-200 px-3 py-2 text-slate-900"
                />
              </label>
              <button
                onClick={exportAll}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white"
              >
                <FileSpreadsheet size={16} />
                ดาวน์โหลดทุกไฟล์
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 rounded-2xl bg-slate-100 p-2">
            <TabButton active={activeTab === "income"} onClick={() => setActiveTab("income")} label="รายได้รายเดือน" />
            <TabButton active={activeTab === "move_in"} onClick={() => setActiveTab("move_in")} label="ย้ายเข้า" />
            <TabButton active={activeTab === "move_out"} onClick={() => setActiveTab("move_out")} label="ย้ายออก" />
            <TabButton active={activeTab === "yearly"} onClick={() => setActiveTab("yearly")} label="สรุปทั้งปี" />
            <TabButton active={activeTab === "utilities"} onClick={() => setActiveTab("utilities")} label="ค่าน้ำค่าไฟ" />
            <TabButton active={activeTab === "movement"} onClick={() => setActiveTab("movement")} label="การเคลื่อนไหวห้อง" />
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
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
                <label className="space-y-1 text-sm text-slate-600">
                  <span className="block font-medium">เดือน</span>
                  <input
                    type="month"
                    value={selectedMonth}
                    onChange={(event) => setSelectedMonth(event.target.value)}
                    className="rounded-xl border border-slate-200 px-3 py-2 text-slate-900"
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
              { label: "ค่าไฟที่เรียกเก็บ", value: formatMoney(incomeSummary.electricityCollected) },
              { label: "ค่าน้ำที่เรียกเก็บ", value: formatMoney(incomeSummary.waterCollected) },
            ]}
          />
          <ReportTable
            headers={["อาคาร", "เลขห้อง", "ชื่อผู้เช่า", "หน่วยไฟ", "ค่าไฟ", "หน่วยน้ำ", "ค่าน้ำ", "ยอดเรียกเก็บ", "วิธีชำระ", "สถานะ", "ค่าธรรมเนียมเพิ่มเติม"]}
            rows={filteredIncomeRows.map((row) => [
              row.building_name,
              row.room_number,
              row.tenant_name,
              row.electricityUsage.toLocaleString("th-TH"),
              formatMoney(row.electricity_bill),
              row.waterUsage.toLocaleString("th-TH"),
              formatMoney(row.water_bill),
              formatMoney(row.total_amount),
              row.paymentMethod,
              statusLabel(row.status),
              row.additionalFeeText,
            ])}
            emptyText={`ไม่พบข้อมูลรายได้ของเดือน ${selectedMonth}`}
          />
        </>
      )}

      {activeTab === "move_in" && (
        <>
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
                emptyText="ไม่มีข้อมูลย้ายเข้าในปีนี้"
                embedded
              />
            </CardContent>
          </Card>
        </>
      )}

      {activeTab === "move_out" && (
        <>
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
                emptyText="ไม่มีข้อมูลย้ายออกในปีนี้"
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
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">รายงานการเคลื่อนไหวห้องและผู้เช่า</h3>
                  <p className="text-sm text-slate-500">ดูว่าห้องไหนมีการย้ายเข้า ย้ายออก หรือย้ายห้องเมื่อใด</p>
                </div>
                <ExportButton onClick={exportMovement} />
              </div>
              <ReportTable
                headers={["อาคาร", "ห้อง", "วันที่", "ประเภท", "ชื่อผู้เช่า", "รายละเอียด"]}
                rows={movementRows.map((row) => [
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
      className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
        active ? "bg-white text-blue-700 shadow-sm" : "text-slate-600 hover:bg-white/70"
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
      className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-700"
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
