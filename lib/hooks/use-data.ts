import useSWR from "swr";
import { createClient } from "@/lib/supabase-client";
import type { 
  RoomRow, 
  TenantRow, 
  InvoiceRow, 
  SettingsRates, 
  MoveOutRequestRow,
  PaymentMethod,
  ReceiptProfile
} from "@/types";

const supabase = createClient();

const fetcher = async <T>(key: string | null): Promise<T | null> => {
  if (!key) return null;
  // This is a generic wrapper around Supabase queries, but since each query is unique,
  // we'll pass the actual query promise as the fetcher argument instead of using a global fetcher.
  // So we don't strictly need a global fetcher here if we pass custom fetchers to useSWR.
  return null;
};

// Rooms
export const useRooms = () => {
  return useSWR<RoomRow[]>("rooms", async () => {
    const { data, error } = await supabase
      .from("rooms")
      .select("id,room_number,price_month,buildings(name)")
      .order("room_number");
    
    if (error) throw error;
    
    // Sort rooms by building then room number
    const sorted = ((data ?? []) as RoomRow[]).sort((a, b) => {
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
export const useTenants = () => {
  return useSWR<TenantRow[]>("tenants", async () => {
    const { data, error } = await supabase
      .from("tenants")
      .select(
        "id,full_name,address,phone_number,line_user_id,move_in_date,move_out_date,status,room_id,lease_months,initial_electricity_reading,initial_water_reading,advance_rent_amount,security_deposit_amount,deposit_slip_url,final_electricity_reading,final_water_reading,forfeit_security_deposit,custom_payment_method,custom_receipt_profile,rooms(room_number,price_month,buildings(name))"
      )
      .order("move_in_date", { ascending: false });

    if (error) throw error;
    return (data ?? []) as TenantRow[];
  });
};

// Settings (Rates)
export const useSettingsRates = () => {
  return useSWR<SettingsRates>("settings-rates", async () => {
    const { data, error } = await supabase
      .from("settings")
      .select("water_rate,electricity_rate")
      .eq("id", 1)
      .maybeSingle();
      
    if (error) throw error;
    
    return {
      water_rate: Number((data as any)?.water_rate ?? 0),
      electricity_rate: Number((data as any)?.electricity_rate ?? 0),
    };
  });
};

// Payment Methods
export const usePaymentMethods = () => {
  return useSWR<PaymentMethod[]>("payment-methods", async () => {
    const { data, error } = await supabase
      .from("payment_methods")
      .select("id,label,bank_name,account_name,account_number,qr_url")
      .order("label", { ascending: true });
      
    if (error) throw error;
    return (data ?? []) as PaymentMethod[];
  });
};

// Receipt Profiles
export const useReceiptProfiles = () => {
  return useSWR<ReceiptProfile[]>("receipt-profiles", async () => {
    const { data, error } = await supabase
      .from("receipt_profiles")
      .select("id,label,company_name,tax_id,branch,address")
      .order("label", { ascending: true });
      
    if (error) throw error;
    return (data ?? []) as ReceiptProfile[];
  });
};

// Move Out Requests
export const useMoveOutRequests = () => {
  return useSWR<MoveOutRequestRow[]>("move-out-requests", async () => {
    const { data, error } = await supabase
      .from("move_out_requests")
      .select(
        "id,tenant_id,notice_date,requested_move_out_date,approved_move_out_date,actual_move_out_date,status,request_note,admin_note,created_at"
      )
      .in("status", ["requested", "approved"])
      .order("created_at", { ascending: false });

    if (error) throw error;
    return (data ?? []) as MoveOutRequestRow[];
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

export const useMeterReadingsRawData = (selectedMonth: string) => {
  return useSWR(`meters-raw-${selectedMonth}`, async () => {
    const [year, month] = selectedMonth.split("-").map(Number);
    const currentMonthDate = new Date(year, month - 1, 1);
    const prevMonthDate = new Date(year, month - 2, 1);
    const nextMonthDate = new Date(year, month, 1);

    const currentMonthKey = `${currentMonthDate.getFullYear()}-${String(currentMonthDate.getMonth() + 1).padStart(2, "0")}-01`;
    const prevMonthKey = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, "0")}-01`;
    const nextMonthKey = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, "0")}-01`;

    const [
      { data: roomData, error: roomError },
      { data: currentReadings },
      { data: previousReadings },
      { data: activeTenants }
    ] = await Promise.all([
      supabase.from("rooms").select("id,room_number,buildings(name)").order("room_number", { ascending: true }),
      supabase.from("meter_readings")
        .select("id,room_id,reading_month,created_at,previous_electricity,current_electricity,electricity_usage,previous_water,current_water,water_usage,previous_reading,current_reading,usage")
        .gte("reading_month", currentMonthKey).lt("reading_month", nextMonthKey)
        .order("reading_month", { ascending: false }).order("created_at", { ascending: false }),
      supabase.from("meter_readings")
        .select("id,room_id,reading_month,created_at,current_electricity,current_water,current_reading")
        .gte("reading_month", prevMonthKey).lt("reading_month", currentMonthKey)
        .order("reading_month", { ascending: false }).order("created_at", { ascending: false }),
      supabase.from("tenants")
        .select("id,room_id,full_name,move_in_date,initial_electricity_reading,initial_water_reading,status")
        .lt("move_in_date", nextMonthKey).eq("status", "active")
        .order("move_in_date", { ascending: false })
    ]);

    if (roomError) throw new Error(roomError.message);

    const activeTenantIds = ((activeTenants ?? []) as any[]).map((item) => String(item?.id ?? "")).filter(Boolean);
    let tenantInvoices: any[] = [];
    if (activeTenantIds.length > 0) {
      // Up through the end of the currently-viewed month, not just before it —
      // otherwise a regular invoice already generated FOR this month is
      // invisible to this check, and the room keeps showing the "first
      // billing cycle" banner even after it's no longer true.
      const { data } = await supabase.from("invoices")
        .select("tenant_id,start_date,status")
        .in("tenant_id", activeTenantIds)
        .lt("start_date", nextMonthKey)
        .neq("status", "cancelled");
      tenantInvoices = data ?? [];
    }

    return {
      roomData,
      currentReadings,
      previousReadings,
      activeTenants,
      tenantInvoices,
      currentMonthKey,
      nextMonthKey,
    };
  });
};
