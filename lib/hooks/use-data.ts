import useSWR from "swr";
import { createClient } from "@/lib/supabase-client";
import type {
  RoomRow,
  TenantRow,
  MoveOutRequestRow,
} from "@/types";

const supabase = createClient();

const authHeaders = async () => {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
};

const callTenantsAction = async (action: string, payload: Record<string, unknown> = {}) => {
  const response = await fetch("/api/admin/tenants/actions", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error ?? `Action ${action} failed`);
  return data;
};

// Rooms
// Moved server-side (finding C1) — see app/api/admin/rooms/route.ts.
export const useRooms = () => {
  return useSWR<RoomRow[]>("rooms", async () => {
    const response = await fetch("/api/admin/rooms", { headers: await authHeaders() });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.error ?? "โหลดข้อมูลห้องไม่สำเร็จ");

    const sorted = ((result.rooms ?? []) as RoomRow[]).sort((a, b) => {
      const aBuilding = Array.isArray(a.buildings) ? a.buildings[0]?.name ?? "" : a.buildings?.name ?? "";
      const bBuilding = Array.isArray(b.buildings) ? b.buildings[0]?.name ?? "" : b.buildings?.name ?? "";
      const byBuilding = aBuilding.localeCompare(bBuilding, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      if (byBuilding !== 0) return byBuilding;
      return a.room_number.localeCompare(b.room_number, undefined, { numeric: true, sensitivity: "base" });
    });

    return sorted;
  });
};

// Tenants
// Moved server-side (finding C1) — see get_tenants in
// app/api/admin/tenants/actions/route.ts.
export const useTenants = () => {
  return useSWR<TenantRow[]>("tenants", async () => {
    const result = await callTenantsAction("get_tenants");
    return (result.tenants ?? []) as TenantRow[];
  });
};

// Move Out Requests
// Moved server-side (finding C1) — see get_move_out_requests in
// app/api/admin/tenants/actions/route.ts.
export const useMoveOutRequests = () => {
  return useSWR<MoveOutRequestRow[]>("move-out-requests", async () => {
    const result = await callTenantsAction("get_move_out_requests");
    return (result.requests ?? []) as MoveOutRequestRow[];
  });
};

export type DashboardStats = {
  totalOutstanding: number;
  overdueInvoicesCount: number;
  pendingInvoicesCount: number;
  verifyingInvoicesCount: number;
  requestedMoveOutsCount: number;
  occupancyRate: number;
  activeTenantsCount: number;
  totalRoomsCount: number;
  vacantRoomsCount: number;
  upcomingMoveInsCount: number;
  upcomingMoveOutsCount: number;
  buildingStats: { building: string; total: number; occupied: number; vacant: number; occupancy: number }[];


  anomalies: { id: string; text: string; severity: "high" | "medium" }[];
  recentActivities: { id: string; text: string; created_at: string }[];
  monthlyTrend: { month: string; collected: number; outstanding: number }[];
  utilityTrend: { month: string; electricity: number; water: number }[];
};

export const useDashboardStats = () => {
  return useSWR<DashboardStats>("dashboard-stats", async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const res = await fetch("/api/admin/dashboard-stats", {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text);
    }
    return res.json();
  });
};

// Moved server-side (finding C1) — see app/api/admin/meters/raw-data/route.ts.
export const useMeterReadingsRawData = (selectedMonth: string) => {
  return useSWR(`meters-raw-${selectedMonth}`, async () => {
    const response = await fetch("/api/admin/meters/raw-data", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ selectedMonth }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.error ?? "โหลดข้อมูลมิเตอร์ไม่สำเร็จ");
    return result;
  });
};
