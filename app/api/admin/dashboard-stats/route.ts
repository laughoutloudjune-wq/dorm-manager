import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import { toNumber, formatMoney } from "@/lib/format";
import { sumOwnOutstanding } from "@/lib/invoice-ledger";

const monthKey = (value: string) => String(value).slice(0, 7);
const relationItem = <T,>(value: T | T[] | null | undefined): T | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

const translateInvoiceStatus = (status: string) => {
  switch (status) {
    case "paid":
      return "ชำระแล้ว";
    case "verifying":
      return "รอตรวจสอบ";
    case "overdue":
      return "เกินกำหนด";
    case "partial":
      return "ชำระบางส่วน";
    case "pending":
      return "รอชำระ";
    case "draft":
      return "ฉบับร่าง";
    case "abandoned":
      return "ทิ้งห้อง";
    default:
      return status;
  }
};

export async function GET(req: Request) {
  try {
    const auth = await requireAdminPermission(req, "tenant.view");
    if ("error" in auth) return auth.error;
    const { supabase } = auth;

    const today = new Date();
    const sixMonthsAgoDate = new Date(today.getFullYear(), today.getMonth() - 5, 1);
    const sixMonthsAgoKey = `${sixMonthsAgoDate.getFullYear()}-${String(sixMonthsAgoDate.getMonth() + 1).padStart(2, "0")}-01`;

    const [roomsRes, tenantsRes, invoicesRes, metersRes, moveOutRequestsRes] = await Promise.all([
      supabase.from("rooms").select("id,room_number,status,buildings(name)").order("room_number"),
      supabase
        .from("tenants")
        .select("id,full_name,room_id,status,move_in_date,move_out_date,created_at,custom_payment_method,rooms(room_number,buildings(name))")
        .order("created_at", { ascending: false }),
      supabase
        .from("invoices")
        .select("id,status,total_amount,paid_amount,carry_forward_amount,created_at,start_date,due_date,slip_url,room_id,tenant_id,rooms(room_number,buildings(name)),tenants(full_name)")
        .or(`start_date.gte.${sixMonthsAgoKey},status.in.(pending,partial,overdue,verifying)`)
        .order("created_at", { ascending: false }),
      supabase
        .from("meter_readings")
        .select("id,room_id,reading_month,electricity_usage,water_usage,rooms(room_number,buildings(name))")
        .gte("reading_month", sixMonthsAgoKey)
        .order("reading_month", { ascending: false }),
      supabase
        .from("move_out_requests")
        .select("id,tenant_id,notice_date,requested_move_out_date,approved_move_out_date,actual_move_out_date,status,created_at,tenants(full_name,rooms(room_number,buildings(name)))")
        .order("created_at", { ascending: false }),
    ]);

    const firstError =
      roomsRes.error ||
      tenantsRes.error ||
      invoicesRes.error ||
      metersRes.error ||
      moveOutRequestsRes.error;

    if (firstError) {
      return NextResponse.json({ error: firstError.message }, { status: 500 });
    }

    const rooms = roomsRes.data ?? [];
    const tenants = tenantsRes.data ?? [];
    const invoices = (invoicesRes.data ?? []).filter((row: any) => String(row.status) !== "draft");
    const meters = metersRes.data ?? [];
    const moveOutRequests = moveOutRequestsRes.data ?? [];

    const todayText = today.toISOString().slice(0, 10);
    const in30Days = new Date(today);
    in30Days.setDate(in30Days.getDate() + 30);
    const in30DaysText = in30Days.toISOString().slice(0, 10);

    const activeTenants = tenants.filter((tenant) => tenant.status === "active");
    const requestedMoveOuts = moveOutRequests.filter((row) => String(row.status) === "requested");
    const activeTenantRoomIds = new Set(activeTenants.map((tenant) => String(tenant.room_id)));

    const outstandingStatuses = ["pending", "partial", "overdue", "verifying"];
    const pendingInvoices = invoices.filter((invoice) => ["pending", "partial", "overdue"].includes(String(invoice.status)));
    // Genuinely status='verifying' only — a slip attached to a partial/overdue
    // invoice from an earlier payment is not awaiting review. The old
    // "has a slip AND isn't paid" heuristic over-counted every such invoice;
    // live data checked at time of writing showed 4/4 counted invoices were
    // false positives, zero of them actually verifying.
    const verifyingInvoices = invoices.filter((invoice) => String(invoice.status) === "verifying");
    const overdueInvoices = invoices.filter((invoice) => String(invoice.status) === "overdue");
    const outstandingInvoices = invoices.filter((invoice) => outstandingStatuses.includes(String(invoice.status)));

    // Own-outstanding, not raw total-paid — a tenant behind on two carried
    // invoices otherwise gets the same debt counted once per invoice it was
    // bundled into.
    const totalOutstanding = sumOwnOutstanding(outstandingInvoices);
    const overdueAmount = sumOwnOutstanding(overdueInvoices);

    const upcomingMoveIns = tenants.filter((tenant) => {
      const date = String(tenant.move_in_date ?? "");
      return date >= todayText && date <= in30DaysText;
    });
    const upcomingMoveOuts = tenants.filter((tenant) => {
      const date = String(tenant.move_out_date ?? "");
      return date >= todayText && date <= in30DaysText;
    });

    const vacantRooms = rooms.filter((room) => ["available", "vacant"].includes(String(room.status)));
    const occupancyRate = rooms.length > 0 ? Math.round((activeTenants.length / rooms.length) * 100) : 0;

    const byBuilding = new Map<string, { total: number; occupied: number; vacant: number }>();
    for (const room of rooms) {
      const building = relationItem(room.buildings)?.name ?? "ไม่ระบุอาคาร";
      const current = byBuilding.get(building) ?? { total: 0, occupied: 0, vacant: 0 };
      current.total += 1;
      if (["available", "vacant"].includes(String(room.status))) current.vacant += 1;
      if (String(room.status) === "occupied") current.occupied += 1;
      byBuilding.set(building, current);
    }
    const buildingStats = [...byBuilding.entries()]
      .map(([building, value]) => ({
        building,
        ...value,
        occupancy: value.total > 0 ? Math.round((value.occupied / value.total) * 100) : 0,
      }))
      .sort((a, b) => a.building.localeCompare(b.building, undefined, { numeric: true, sensitivity: "base" }));

    const latestMeterMonth = meters.length > 0 ? monthKey(String(meters[0].reading_month)) : null;
    const meterKeySet = new Set(
      meters
        .filter((row) => !latestMeterMonth || monthKey(String(row.reading_month)) === latestMeterMonth)
        .map((row) => `${row.room_id}:${monthKey(String(row.reading_month))}`)
    );
    const invoiceKeySet = new Set(
      invoices
        .filter((row) => !latestMeterMonth || monthKey(String(row.start_date)) === latestMeterMonth)
        .map((row) => `${row.room_id}:${monthKey(String(row.start_date))}`)
    );

    const anomalies: { id: string; text: string; severity: "high" | "medium" }[] = [];
    for (const room of rooms) {
      const roomId = String(room.id);
      const roomNo = String(room.room_number ?? "-");
      const status = String(room.status ?? "");
      if (status === "occupied" && !activeTenantRoomIds.has(roomId)) {
        anomalies.push({ id: `occupied-no-tenant-${roomId}`, text: `ห้อง ${roomNo} สถานะเป็นมีผู้เช่า แต่ไม่พบผู้เช่า active`, severity: "high" });
      }
      if (status !== "occupied" && activeTenantRoomIds.has(roomId)) {
        anomalies.push({ id: `tenant-room-mismatch-${roomId}`, text: `ห้อง ${roomNo} มีผู้เช่า active แต่สถานะห้องไม่ใช่ occupied`, severity: "high" });
      }
      if (latestMeterMonth && meterKeySet.has(`${roomId}:${latestMeterMonth}`) && !invoiceKeySet.has(`${roomId}:${latestMeterMonth}`)) {
        anomalies.push({ id: `meter-no-invoice-${roomId}`, text: `ห้อง ${roomNo} มีมิเตอร์เดือน ${latestMeterMonth} แต่ไม่มีบิล`, severity: "medium" });
      }
      if (latestMeterMonth && invoiceKeySet.has(`${roomId}:${latestMeterMonth}`) && !meterKeySet.has(`${roomId}:${latestMeterMonth}`)) {
        anomalies.push({ id: `invoice-no-meter-${roomId}`, text: `ห้อง ${roomNo} มีบิลเดือน ${latestMeterMonth} แต่ไม่มีมิเตอร์`, severity: "medium" });
      }
    }
    for (const tenant of activeTenants) {
      if (tenant.custom_payment_method) continue;
      const room = relationItem(tenant.rooms);
      const roomNo = room?.room_number ?? "-";
      anomalies.push({
        id: `no-payment-method-${tenant.id}`,
        text: `ห้อง ${roomNo} (${tenant.full_name ?? "-"}) ยังไม่ได้ตั้งบัญชีรับโอนเงินเฉพาะห้อง — ใช้บัญชีเริ่มต้นแทน`,
        severity: "medium",
      });
    }

    const recentActivities = [
      ...invoices.slice(0, 5).map((invoice: any) => {
        const room = relationItem(invoice.rooms);
        return {
          id: `invoice-${invoice.id}`,
          text: `บิลห้อง ${room?.room_number ?? "-"} สถานะ ${translateInvoiceStatus(String(invoice.status ?? ""))} ยอด ฿${formatMoney(toNumber(invoice.total_amount))}`,
          created_at: invoice.created_at,
        };
      }),
      ...tenants.slice(0, 5).map((tenant: any) => {
        const room = relationItem(tenant.rooms);
        return {
          id: `tenant-${tenant.id}`,
          text: `ผู้เช่า ${tenant.full_name} ห้อง ${room?.room_number ?? "-"}`,
          created_at: tenant.created_at,
        };
      }),
    ]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 8);

    const monthBuckets = Array.from({ length: 6 }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth() - (5 - index), 1);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    });

    const monthlyTrend = monthBuckets.map((month) => {
      const monthInvoices = invoices.filter((invoice) => monthKey(String(invoice.start_date)) === month);
      return {
        month,
        collected: monthInvoices.filter((invoice) => String(invoice.status) === "paid").reduce((sum, invoice) => sum + toNumber(invoice.paid_amount || invoice.total_amount), 0),
        outstanding: monthInvoices
          .filter((invoice) => ["pending", "partial", "overdue", "verifying"].includes(String(invoice.status)))
          .reduce((sum, invoice) => sum + Math.max(toNumber(invoice.total_amount) - toNumber(invoice.paid_amount), 0), 0),
      };
    });

    const utilityTrend = monthBuckets.map((month) => {
      const monthMeters = meters.filter((meter) => monthKey(String(meter.reading_month)) === month);
      return {
        month,
        electricity: monthMeters.reduce((sum, meter) => sum + toNumber(meter.electricity_usage), 0),
        water: monthMeters.reduce((sum, meter) => sum + toNumber(meter.water_usage), 0),
      };
    });

    return NextResponse.json({
      totalOutstanding,
      overdueInvoicesCount: overdueInvoices.length,
      pendingInvoicesCount: pendingInvoices.length,
      verifyingInvoicesCount: verifyingInvoices.length,
      requestedMoveOutsCount: requestedMoveOuts.length,
      occupancyRate,
      activeTenantsCount: activeTenants.length,
      totalRoomsCount: rooms.length,
      vacantRoomsCount: vacantRooms.length,
      upcomingMoveInsCount: upcomingMoveIns.length,
      upcomingMoveOutsCount: upcomingMoveOuts.length,
      buildingStats,
      anomalies,
      recentActivities,
      monthlyTrend,
      utilityTrend,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
